// Proves SqliteIntentStore matches the durable-outbox spec by running the same
// conformance corpus against it and the reference MemoryIntentStore.
import { describe, expect, test } from "vitest";

import {
  MemoryIntentStore,
  ReplicaProtocolError,
} from "@centraid/client/replica/native";
import type {
  IntentRecordStore,
  NewStoredIntent,
} from "@centraid/client/replica/native";

import { NodeSqliteDriver } from "./node-sqlite-driver";
import { SqliteIntentStore } from "./sqlite-intent-store";

function newIntent(overrides: Partial<NewStoredIntent> = {}): NewStoredIntent {
  return {
    intentId: "intent-1",
    payloadHash: "hash-1",
    appId: "photos",
    action: "rename",
    input: { title: "Beach" },
    state: "queued",
    attempts: 0,
    optimistic: [],
    dependencies: [],
    ...overrides,
  };
}

function runIntentStoreConformance(makeStore: () => IntentRecordStore): void {
  test("add is idempotent for the same id and payload hash", async () => {
    const store = makeStore();
    const first = await store.add(newIntent());
    const again = await store.add(newIntent());
    expect(again).toStrictEqual(first);
    await expect(store.list()).resolves.toHaveLength(1);
  });

  test("add rejects a reused id carrying a different payload", async () => {
    const store = makeStore();
    await store.add(newIntent());
    await expect(
      store.add(newIntent({ payloadHash: "hash-2" }))
    ).rejects.toBeInstanceOf(ReplicaProtocolError);
  });

  test("assigns strictly increasing createdOrder that survives deletes", async () => {
    const store = makeStore();
    const a = await store.add(newIntent({ intentId: "a" }));
    const b = await store.add(newIntent({ intentId: "b" }));
    expect(b.createdOrder).toBeGreaterThan(a.createdOrder);
    await store.settle("a", ["queued"], { state: "executed" });
    const c = await store.add(newIntent({ intentId: "c" }));
    expect(c.createdOrder).toBeGreaterThan(b.createdOrder);
  });

  test("claimNext atomically moves the oldest queued intent to sending", async () => {
    const store = makeStore();
    await store.add(newIntent({ intentId: "a" }));
    await store.add(newIntent({ intentId: "b" }));
    const claimed = await store.claimNext();
    expect(claimed?.intentId).toBe("a");
    expect(claimed?.state).toBe("sending");
    expect(claimed?.attempts).toBe(1);
    expect((await store.get("a"))?.state).toBe("sending");
    expect((await store.claimNext())?.intentId).toBe("b");
    await expect(store.claimNext()).resolves.toBeUndefined();
  });

  test("transition enforces the allowed states and clears reason on undefined", async () => {
    const store = makeStore();
    await store.add(newIntent());
    await store.claimNext();
    await store.transition("intent-1", ["sending"], {
      state: "queued",
      reason: "network",
    });
    expect((await store.get("intent-1"))?.reason).toBe("network");
    await store.claimNext();
    const cleared = await store.transition("intent-1", ["sending"], {
      state: "awaiting-change",
      reason: undefined,
    });
    expect(cleared.state).toBe("awaiting-change");
    expect(cleared.reason).toBeUndefined();
    await expect(
      store.transition("intent-1", ["sending"], { state: "queued" })
    ).rejects.toBeInstanceOf(ReplicaProtocolError);
    await expect(
      store.transition("missing", ["queued"], {})
    ).rejects.toBeInstanceOf(ReplicaProtocolError);
  });

  test("settle returns the settled value and deletes the row (scrubbing input)", async () => {
    const store = makeStore();
    await store.add(newIntent());
    await store.claimNext();
    const settled = await store.settle("intent-1", ["sending"], {
      state: "executed",
      output: { ok: true },
    });
    expect(settled.state).toBe("executed");
    expect(settled.output).toStrictEqual({ ok: true });
    await expect(store.get("intent-1")).resolves.toBeUndefined();
    await expect(store.list()).resolves.toHaveLength(0);
  });

  test("retains a structured conflict outcome after scrubbing the queued input", async () => {
    const store = makeStore();
    await store.add(newIntent());
    await store.claimNext();
    await store.settle("intent-1", ["sending"], {
      state: "failed",
      reason: "canonical row changed",
      conflict: {
        entity: "core.event",
        rowId: "event-1",
        expectedVersion: 4,
        actualVersion: 5,
      },
    });
    await expect(store.get("intent-1")).resolves.toBeUndefined();
    await expect(store.listSettled()).resolves.toMatchObject([
      {
        intentId: "intent-1",
        status: "conflict",
        conflict: {
          entity: "core.event",
          rowId: "event-1",
          expectedVersion: 4,
          actualVersion: 5,
        },
      },
    ]);
  });

  test("list filters by state in createdOrder", async () => {
    const store = makeStore();
    await store.add(newIntent({ intentId: "a" }));
    await store.add(newIntent({ intentId: "b" }));
    await store.add(newIntent({ intentId: "c" }));
    await store.claimNext(); // a -> sending
    expect(
      (await store.list(["queued"])).map((intent) => intent.intentId)
    ).toStrictEqual(["b", "c"]);
    expect(
      (await store.list(["sending"])).map((intent) => intent.intentId)
    ).toStrictEqual(["a"]);
  });

  // Issue #738: settle scrubs the intent, so without this journal a denied
  // create's row leaves every read and the member never learns it was refused.
  test("journals a settled non-executed write for attention, with its projection and payload", async () => {
    const store = makeStore();
    const optimistic = [
      {
        op: "upsert" as const,
        shapeId: "shape-photos",
        entity: "media.media_asset",
        rowId: "pending-a",
        values: { title: "Beach" },
      },
    ];
    await store.add(newIntent({ intentId: "a", optimistic }));
    await store.settle("a", ["queued"], {
      state: "denied",
      reason: "the owner said no",
    });

    await expect(store.list()).resolves.toHaveLength(0);
    await expect(store.attention()).resolves.toStrictEqual([
      {
        intentId: "a",
        status: "denied",
        appId: "photos",
        action: "rename",
        reason: "the owner said no",
        optimistic,
        input: { title: "Beach" },
        settledAt: expect.any(String),
      },
    ]);
  });

  test("journals a conflict under its own status and nothing for an execution", async () => {
    const store = makeStore();
    const conflict = {
      entity: "media.media_asset",
      rowId: "asset-1",
      expectedVersion: 2,
      actualVersion: 6,
    };
    await store.add(newIntent({ intentId: "a" }));
    await store.settle("a", ["queued"], { state: "failed", conflict });
    await store.add(newIntent({ intentId: "b" }));
    await store.settle("b", ["queued"], { state: "executed" });

    await expect(store.attention()).resolves.toMatchObject([
      { intentId: "a", status: "conflict", conflict },
    ]);
  });

  test("an attention record leaves only when the member answers it", async () => {
    const store = makeStore();
    await store.add(newIntent({ intentId: "a" }));
    await store.settle("a", ["queued"], { state: "failed" });

    await expect(store.attention()).resolves.toHaveLength(1);
    await expect(store.dismissAttention("a")).resolves.toBe(true);
    await expect(store.attention()).resolves.toStrictEqual([]);
    await expect(store.dismissAttention("a")).resolves.toBe(false);
  });

  test("clear empties the store", async () => {
    const store = makeStore();
    await store.add(newIntent({ intentId: "a" }));
    await store.add(newIntent({ intentId: "b" }));
    await store.clear();
    await expect(store.list()).resolves.toHaveLength(0);
  });
}

describe("MemoryIntentStore (reference)", () => {
  runIntentStoreConformance(() => new MemoryIntentStore());
});

describe("SqliteIntentStore (node:sqlite stand-in)", () => {
  runIntentStoreConformance(() =>
    SqliteIntentStore.create(new NodeSqliteDriver())
  );
});
