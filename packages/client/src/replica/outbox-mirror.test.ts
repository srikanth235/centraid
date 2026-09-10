import { describe, expect, test } from "vitest";

import type { IntentRecordStore } from "./intent-record-store.js";
import { IntentQueue } from "./intents.js";
import { MemoryIntentStore } from "./memory-intent-store.js";
import { invalidateOutboxMirror, mirrorOutbox } from "./outbox-mirror.js";

/** Wrap a store so every call it receives is counted by name. */
function counted(store: IntentRecordStore): {
  store: IntentRecordStore;
  calls: Map<string, number>;
} {
  const calls = new Map<string, number>();
  const wrapped = new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const name = String(property);
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return (value as (...args: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: wrapped, calls };
}

const upsert = {
  op: "upsert" as const,
  shapeId: "shape",
  entity: "core.task",
  rowId: "task-1",
  values: { title: "offline" },
};

describe("the outbox overlay mirror", () => {
  test("an empty outbox costs no store work per read", async () => {
    const { store, calls } = counted(new MemoryIntentStore());
    const queue = new IntentQueue(store, { idFactory: () => "intent-1" });
    // One read warms the mirror; every read after it is free.
    await queue.overlay();
    const warm = calls.get("list") ?? 0;
    expect(warm).toBe(1);
    await Promise.all(Array.from({ length: 20 }, () => queue.overlay()));
    expect(calls.get("list")).toBe(warm);
  });

  test("a non-empty outbox is one memory lookup, and a write invalidates it", async () => {
    const { store, calls } = counted(new MemoryIntentStore());
    const queue = new IntentQueue(store, { idFactory: () => "intent-1" });
    await queue.overlay();
    await queue.enqueue({
      appId: "tasks",
      action: "edit",
      input: { title: "offline" },
      optimistic: [upsert],
    });
    const afterEnqueue = calls.get("list") ?? 0;
    // The enqueue invalidated the mirror, so the next read re-reads once…
    expect((await queue.overlay()).mutations).toHaveLength(1);
    expect(calls.get("list")).toBe(afterEnqueue + 1);
    // …and every read after that is memory again.
    const repeats = await Promise.all(
      Array.from({ length: 20 }, () => queue.overlay())
    );
    expect(repeats.every((each) => each.mutations.length === 1)).toBe(true);
    expect(calls.get("list")).toBe(afterEnqueue + 1);
  });

  test("a settlement the queue did not make through a write path still invalidates", async () => {
    const { store, calls } = counted(new MemoryIntentStore());
    const queue = new IntentQueue(store, { idFactory: () => "intent-1" });
    await queue.enqueue({
      appId: "tasks",
      action: "edit",
      input: { title: "offline" },
      optimistic: [upsert],
    });
    await queue.claimNext();
    await queue.overlay();
    const before = calls.get("list") ?? 0;
    await queue.applyOutcomes([{ intentId: "intent-1", status: "executed" }]);
    expect((await queue.overlay()).mutations).toStrictEqual([]);
    expect(calls.get("list")).toBe(before + 1);
  });
});

describe("what the mirror cannot see for itself (#1014, C11)", () => {
  test("caches per states asked for, not one answer for every question", async () => {
    const store = new MemoryIntentStore();
    const mirror = mirrorOutbox(store);
    await store.add({
      intentId: "i-queued",
      payloadHash: "h1",
      appId: "tasks",
      action: "edit",
      input: {},
      state: "queued",
      attempts: 0,
      optimistic: [],
    });
    await store.add({
      intentId: "i-parked",
      payloadHash: "h2",
      appId: "tasks",
      action: "edit",
      input: {},
      state: "parked",
      attempts: 0,
      optimistic: [],
    });
    // The wide question first. The narrow one used to be served its answer.
    await expect(mirror.pending(["queued", "parked"])).resolves.toHaveLength(2);
    const narrow = await mirror.pending(["queued"]);
    expect(narrow.map((each) => each.intentId)).toStrictEqual(["i-queued"]);
  });

  test("a write outside the proxy is invalidated by id, not left stale", async () => {
    const store = new MemoryIntentStore();
    const mirror = mirrorOutbox(store);
    await store.add({
      intentId: "i-1",
      payloadHash: "h",
      appId: "tasks",
      action: "edit",
      input: {},
      state: "awaiting-change",
      attempts: 0,
      optimistic: [],
    });
    await expect(mirror.pending(["awaiting-change"])).resolves.toHaveLength(1);
    // R24's in-transaction clear: the row goes on the seat's own connection,
    // never through the wrapped store.
    await store.settle("i-1", ["awaiting-change"], { state: "executed" });
    await expect(mirror.pending(["awaiting-change"])).resolves.toHaveLength(1);
    invalidateOutboxMirror(store);
    await expect(mirror.pending(["awaiting-change"])).resolves.toStrictEqual(
      []
    );
  });
});
