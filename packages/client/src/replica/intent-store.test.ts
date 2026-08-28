import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { IndexedDbIntentStore, MemoryIntentStore } from "./intent-store.js";
import type { IntentOutcome } from "./types.js";

describe(IndexedDbIntentStore, () => {
  beforeEach(() => vi.stubGlobal("IDBKeyRange", IDBKeyRange));
  afterEach(() => vi.unstubAllGlobals());

  test("caps the settled journal at what listSettled can read", async () => {
    const factory = new IDBFactory();
    const store = await IndexedDbIntentStore.open(
      `centraid-journal-${crypto.randomUUID()}`,
      factory
    );
    try {
      // Seed the existing journal in one fixture transaction, then exercise
      // the public settle path at the retention boundary. Replaying 10k
      // transactions here only measures fake-IndexedDB setup cost.
      await seedOutcomeJournal(store, 5_000);
      await settled(store, 5_000);
      const journal = await store.listSettled(5_000);
      expect(journal).toHaveLength(5_000);
      expect(
        journal.some((outcome) => outcome.intentId === "intent-5000")
      ).toBe(true);
      expect(journal.some((outcome) => outcome.intentId === "intent-0")).toBe(
        false
      );
    } finally {
      store.close();
    }
  });
});

describe(MemoryIntentStore, () => {
  test("holds the same journal bound as the store it stands in for", async () => {
    const store = new MemoryIntentStore();
    for (let index = 0; index <= 5_000; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- (#880) each settle is its own transaction
      await settled(store, index);
    }
    const journal = await store.listSettled(5_000);
    expect(journal).toHaveLength(5_000);
    // The cap drops the oldest, never the settlement that just landed.
    expect(journal.some((outcome) => outcome.intentId === "intent-5000")).toBe(
      true
    );
    expect(journal.some((outcome) => outcome.intentId === "intent-0")).toBe(
      false
    );
    await expect(store.listSettled(5_001)).rejects.toThrow(
      "Settled outcome limit is invalid"
    );
  });
});

async function settled(
  store: IndexedDbIntentStore | MemoryIntentStore,
  index: number
): Promise<void> {
  await store.add({
    intentId: `intent-${index}`,
    payloadHash: `hash-${index}`,
    appId: "agenda",
    action: "complete",
    input: { taskId: `task-${index}` },
    state: "queued",
    attempts: 0,
    optimistic: [],
    dependencies: [],
  });
  await store.settle(`intent-${index}`, ["queued"], { state: "executed" });
}

async function seedOutcomeJournal(
  store: IndexedDbIntentStore,
  count: number
): Promise<void> {
  const db = (store as unknown as { db: IDBDatabase }).db;
  const tx = db.transaction("outcomes", "readwrite");
  const outcomes = tx.objectStore("outcomes");
  for (let index = 0; index < count; index += 1) {
    outcomes.put({
      intentId: `intent-${index}`,
      status: "executed",
      settledAt: new Date(index).toISOString(),
    } satisfies IntentOutcome);
  }
  await transactionDone(tx);
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "error",
      () => {
        reject(transaction.error ?? new Error("IndexedDB transaction failed"));
      },
      { once: true }
    );
    transaction.addEventListener(
      "abort",
      () =>
        reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
      { once: true }
    );
  });
}
