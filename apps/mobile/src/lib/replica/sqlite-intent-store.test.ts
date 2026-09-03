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

  test("two actors racing claimNext on one queued intent yield a single winner", async () => {
    const store = makeStore();
    await store.add(newIntent());
    const [left, right] = await Promise.all([
      store.claimNext(),
      store.claimNext(),
    ]);
    expect(
      [left, right]
        .map((intent) => intent?.intentId)
        .filter((intentId) => intentId !== undefined)
    ).toStrictEqual(["intent-1"]);
    expect((await store.get("intent-1"))?.state).toBe("sending");
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

  test("clear empties the store", async () => {
    const store = makeStore();
    await store.add(newIntent({ intentId: "a" }));
    await store.add(newIntent({ intentId: "b" }));
    await store.clear();
    await expect(store.list()).resolves.toHaveLength(0);
  });

  test("concurrent admissions all land with unique, strictly increasing order", async () => {
    const store = makeStore();
    const ids = Array.from({ length: 24 }, (_, index) => `race-${index}`);
    await Promise.all(
      ids.map((intentId) =>
        store.add(newIntent({ intentId, payloadHash: `hash-${intentId}` }))
      )
    );

    const listed = await store.list();
    expect(listed).toHaveLength(ids.length);
    const orders = listed.map((intent) => intent.createdOrder);
    expect(new Set(orders).size).toBe(ids.length);
    expect([...orders].sort((a, b) => a - b)).toStrictEqual(orders);
    expect(new Set(listed.map((intent) => intent.intentId))).toStrictEqual(
      new Set(ids)
    );
  });

  test.each([
    ["claim first", true],
    ["admission first", false],
  ])(
    "an admission and a claim leave both intents accounted for (%s)",
    async (_label, claimFirst) => {
      const store = makeStore();
      await store.add(newIntent({ intentId: "first" }));

      const claim = () => store.claimNext();
      const admit = () =>
        store.add(
          newIntent({ intentId: "second", payloadHash: "hash-second" })
        );
      await Promise.all(claimFirst ? [claim(), admit()] : [admit(), claim()]);

      const byId = new Map(
        (await store.list()).map((intent) => [intent.intentId, intent.state])
      );
      expect(byId.get("first")).toBe("sending");
      expect(byId.get("second")).toBe("queued");
      expect(byId.size).toBe(2);
    }
  );

  test.each([
    ["settle first", "settle"],
    ["transition first", "transition"],
  ])(
    "a settle and a transition on one intent leave no orphan row (%s)",
    async (_label, first) => {
      const store = makeStore();
      await store.add(newIntent());
      await store.claimNext();

      const settleFirst = () =>
        store.settle("intent-1", ["sending"], { state: "executed" });
      const transitionFirst = () =>
        store.transition("intent-1", ["sending"], { state: "queued" });
      const ordered =
        first === "settle"
          ? [settleFirst, transitionFirst]
          : [transitionFirst, settleFirst];
      const results = await Promise.allSettled(ordered.map((run) => run()));
      expect(
        results.filter((result) => result.status === "fulfilled")
      ).not.toHaveLength(0);

      const survivors = await store.list();
      const settledIds = new Set(
        (await store.listSettled()).map((outcome) => outcome.intentId)
      );
      const orphans = survivors
        .map((intent) => intent.intentId)
        .filter((intentId) => settledIds.has(intentId));
      expect(orphans).toStrictEqual([]);
      expect(survivors.length + settledIds.size).toBeGreaterThan(0);
    }
  );

  test("interleaved drain workers settle every intent exactly once", async () => {
    const store = makeStore();
    const total = 16;
    await Promise.all(
      Array.from({ length: total }, (_, index) =>
        store.add(
          newIntent({ intentId: `job-${index}`, payloadHash: `hash-${index}` })
        )
      )
    );

    const drained: string[] = [];
    async function worker(): Promise<void> {
      for (;;) {
        // oxlint-disable-next-line no-await-in-loop
        const claimed = await store.claimNext();
        if (!claimed) return;
        drained.push(claimed.intentId);
        // oxlint-disable-next-line no-await-in-loop
        await store.settle(claimed.intentId, ["sending"], {
          state: "executed",
        });
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);

    expect(drained).toHaveLength(total);
    expect(new Set(drained).size).toBe(total);
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

  test("caps the settled journal at what listSettled can read", async () => {
    const driver = new NodeSqliteDriver();
    const store = SqliteIntentStore.create(driver);
    for (let index = 0; index < 5_000; index += 1) {
      driver.run(
        `INSERT INTO replica_intent_outcome(intent_id, settled_at, record_json)
         VALUES (?, ?, ?)`,
        [
          `old-${index}`,
          new Date(Date.UTC(2020, 0, 1) + index * 1_000).toISOString(),
          JSON.stringify({ intentId: `old-${index}`, status: "executed" }),
        ]
      );
    }
    await store.add(newIntent());
    await store.claimNext();
    await store.settle("intent-1", ["sending"], { state: "executed" });

    const [count] = driver.all<{ rows: number }>(
      "SELECT COUNT(*) AS rows FROM replica_intent_outcome"
    );
    expect(count?.rows).toBe(5_000);
    const settled = await store.listSettled(5_000);
    expect(settled[0]?.intentId).toBe("intent-1");
    expect(settled.some((outcome) => outcome.intentId === "old-0")).toBe(false);
  });

  test("stamps the first admission and keeps it across a claim", async () => {
    const store = SqliteIntentStore.create(new NodeSqliteDriver());
    await store.add(newIntent());
    const stamped = store.enqueuedTimes().get("intent-1");
    expect(stamped).toBeTypeOf("string");
    await store.claimNext();
    expect(store.enqueuedTimes().get("intent-1")).toBe(stamped);
    await store.settle("intent-1", ["sending"], { state: "executed" });
    expect(store.enqueuedTimes().has("intent-1")).toBe(false);
  });

  test("refuses an async transaction body instead of committing outside the lock", () => {
    const store = SqliteIntentStore.create(new NodeSqliteDriver());
    const transaction = (
      store as unknown as { transaction: <T>(work: () => T) => T }
    ).transaction.bind(store);
    expect(() => transaction(async () => undefined)).toThrow(
      ReplicaProtocolError
    );
    expect(() => transaction(() => 1)).not.toThrow();
  });
});
