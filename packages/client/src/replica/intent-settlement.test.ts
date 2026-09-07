/*
 * WHO MAY PARK ON A `commit_seq` (#996, R24) — the two store kinds, and why
 * one answer for both was a regression.
 *
 * Since wave 1 every executed answer carries its commit position, and wave 2
 * taught the queue to hold the overlay at `awaiting-change` until the seat's
 * applied cursor reaches it. That is right for the SEAT store, whose outbox
 * shares the seat's file and whose applier clears the overlay inside the
 * transaction carrying the commit. It is wrong for the OLD store — still the
 * shipped read path on today's web and phone — which has no such cursor and
 * nothing that will ever call `settleAtCommitSeq`: there, the pending badge
 * would stay lit forever on a write the gateway had already executed.
 *
 * Red-first: both cases below fail on the tree that read `commit_seq` without
 * asking the store, the second by leaving the intent `awaiting-change`.
 */

import { describe, expect, test } from "vitest";

import type { IntentRecordStore } from "./intent-record-store.js";
import { MemoryIntentStore } from "./intent-store.js";
import { IntentQueue } from "./intents.js";
import { openSeatFile } from "./seat/driver.js";
import { NodeSeatDriver } from "./seat/node-seat-driver.js";
import { SeatIntentStore } from "./seat/seat-intent-store.js";
import type { IntentOutcome } from "./types.js";

const INTENT = "intent-settlement-1";

async function queued(store: IntentRecordStore): Promise<IntentQueue> {
  const queue = new IntentQueue(store, {
    idFactory: () => INTENT,
    digest: (canonical) => Promise.resolve(`digest:${canonical.length}`),
  });
  await queue.enqueue({
    appId: "planner",
    action: "add_task",
    input: { title: "one thought" },
  });
  await queue.claimNext();
  return queue;
}

/** What the gateway answers today: executed, with the commit it landed in. */
const EXECUTED: IntentOutcome = {
  intentId: INTENT,
  status: "executed",
  commitSeq: 12,
};

describe("an executed answer that names its commit position", () => {
  test("parks on the SEAT store, whose applied cursor will reach it", async () => {
    const driver = new NodeSeatDriver();
    openSeatFile(driver);
    const store: IntentRecordStore = SeatIntentStore.create(driver);
    try {
      expect(store.settlesByCommitSeq).toBe(true);
      const queue = await queued(store);
      await queue.applyOutcomes([EXECUTED]);

      const [waiting] = await queue.pending();
      expect(waiting?.state).toBe("awaiting-change");
      expect(waiting?.commitSeq).toBe(12);
      // …and the cursor is what clears it, which is R24 in one sentence.
      await expect(queue.settleAtCommitSeq(11)).resolves.toStrictEqual([]);
      await queue.settleAtCommitSeq(12);
      await expect(queue.pending()).resolves.toStrictEqual([]);
    } finally {
      driver.close();
    }
  });

  test("SETTLES on the old store, which has no cursor to wait for", async () => {
    const store: IntentRecordStore = new MemoryIntentStore();
    expect(store.settlesByCommitSeq).toBeUndefined();
    const queue = await queued(store);

    await queue.applyOutcomes([EXECUTED]);

    // Nothing here will ever call `settleAtCommitSeq`, so parking would be a
    // pending badge the member could not clear by waiting.
    await expect(queue.pending()).resolves.toStrictEqual([]);
    const settled = await queue.listSettled();
    expect(settled.map((outcome) => outcome.status)).toStrictEqual([
      "executed",
    ]);
  });

  test("the old store still waits on ANSWERED VERSIONS it does not hold (#929 G1)", async () => {
    const store = new MemoryIntentStore();
    const queue = await queued(store);

    await queue.applyOutcomes([
      {
        ...EXECUTED,
        answeredVersions: [
          { entity: "schedule.task", rowId: "task-1", version: 4 },
        ],
      },
    ]);

    const [waiting] = await queue.pending();
    expect(waiting?.state).toBe("awaiting-change");
    await queue.settleAnswered(() => true);
    await expect(queue.pending()).resolves.toStrictEqual([]);
  });
});
