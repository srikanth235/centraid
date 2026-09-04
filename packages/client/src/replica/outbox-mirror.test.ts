import { describe, expect, test } from "vitest";

import type { IntentRecordStore } from "./intent-record-store.js";
import { IntentQueue } from "./intents.js";
import { MemoryIntentStore } from "./memory-intent-store.js";

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
    await queue.overlayMutations();
    const warm = calls.get("list") ?? 0;
    expect(warm).toBe(1);
    await Promise.all(
      Array.from({ length: 20 }, () => queue.overlayMutations())
    );
    expect(calls.get("list")).toBe(warm);
  });

  test("a non-empty outbox is one memory lookup, and a write invalidates it", async () => {
    const { store, calls } = counted(new MemoryIntentStore());
    const queue = new IntentQueue(store, { idFactory: () => "intent-1" });
    await queue.overlayMutations();
    await queue.enqueue({
      appId: "tasks",
      action: "edit",
      input: { title: "offline" },
      optimistic: [upsert],
    });
    const afterEnqueue = calls.get("list") ?? 0;
    // The enqueue invalidated the mirror, so the next read re-reads once…
    await expect(queue.overlayMutations()).resolves.toHaveLength(1);
    expect(calls.get("list")).toBe(afterEnqueue + 1);
    // …and every read after that is memory again.
    const repeats = await Promise.all(
      Array.from({ length: 20 }, () => queue.overlayMutations())
    );
    expect(repeats.every((each) => each.length === 1)).toBe(true);
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
    await queue.overlayMutations();
    const before = calls.get("list") ?? 0;
    await queue.applyOutcomes([{ intentId: "intent-1", status: "executed" }]);
    await expect(queue.overlayMutations()).resolves.toStrictEqual([]);
    expect(calls.get("list")).toBe(before + 1);
  });
});
