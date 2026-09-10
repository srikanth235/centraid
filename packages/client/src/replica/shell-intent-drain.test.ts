/*
 * WHAT THE DRAIN DOES WITH AN ANSWER (#1014, R1/R2/P23).
 *
 * The loop used to park an `executed` answer by hand and throw away the one
 * field the overlay clears against, so every executed intent sat at
 * `awaiting-change` with `commit_seq` NULL for the life of the install. These
 * are the three facts that were not true before:
 *
 *   - an executed answer's COMMIT POSITION reaches the outbox record;
 *   - a commit the seat has ALREADY APPLIED settles the record at once,
 *     because the applier's hook has been and gone;
 *   - a successful send retires the transport reason an earlier attempt wrote.
 *
 * Red-first on the tree before the fix: the first two leave `commitSeq`
 * undefined, and the third leaves `fetch failed` under an executed intent.
 */

import { describe, expect, test } from "vitest";

import { IntentQueue } from "./intents.js";
import { openSeatFile } from "./seat/driver.js";
import { NodeSeatDriver } from "./seat/node-seat-driver.js";
import { SeatIntentStore } from "./seat/seat-intent-store.js";
import { drainIntents } from "./shell-intent-drain.js";
import type { IntentDrainHost } from "./shell-intent-drain.js";
import type { IntentOutcome, ReplicaIntent } from "./types.js";

interface Harness {
  readonly queue: IntentQueue;
  readonly host: IntentDrainHost;
  readonly sent: string[];
  readonly settled: ReplicaIntent[];
  close: () => void;
}

function harness(
  answer: (
    intent: ReplicaIntent
  ) => IntentOutcome | { intentId: string; status: "in-flight" },
  appliedCommitSeq?: () => number | undefined
): Harness {
  const driver = new NodeSeatDriver();
  openSeatFile(driver);
  const store = SeatIntentStore.create(driver);
  let next = 0;
  const queue = new IntentQueue(store, {
    idFactory: () => `intent-${++next}`,
    digest: (canonical) => Promise.resolve(`digest:${canonical.length}`),
  });
  const sent: string[] = [];
  const settled: ReplicaIntent[] = [];
  const host: IntentDrainHost = {
    queue,
    send: (intent) => {
      sent.push(intent.intentId);
      return Promise.resolve({ outcome: answer(intent) });
    },
    closed: () => false,
    online: () => true,
    settleRegistrations: () => Promise.resolve(),
    resolve: () => undefined,
    reject: () => undefined,
    rejectAll: () => undefined,
    queueEveryoneWaiting: () => undefined,
    settled: (intent) => settled.push(intent),
    isAuthorizationError: () => false,
    onAuthorizationRevoked: () => undefined,
    scheduleRetry: () => undefined,
    ...(appliedCommitSeq ? { appliedCommitSeq } : {}),
  };
  return { queue, host, sent, settled, close: () => driver.close() };
}

async function enqueue(queue: IntentQueue, title: string): Promise<string> {
  const intent = await queue.enqueue({
    appId: "planner",
    action: "add_task",
    input: { title },
  });
  return intent.intentId;
}

describe("an executed answer with a commit position", () => {
  test("carries `commitSeq` onto the outbox record (R1)", async () => {
    const kit = harness((intent) => ({
      intentId: intent.intentId,
      status: "executed",
      commitSeq: 41,
    }));
    try {
      const intentId = await enqueue(kit.queue, "one thought");
      await drainIntents(kit.host);
      const [record] = await kit.queue.list();
      expect(record?.intentId).toBe(intentId);
      expect(record?.state).toBe("awaiting-change");
      expect(record?.commitSeq).toBe(41);
      // And the cursor reaching it is now able to settle it.
      const [cleared] = await kit.queue.settleAtCommitSeq(41);
      expect(cleared?.state).toBe("executed");
      await expect(kit.queue.list()).resolves.toStrictEqual([]);
    } finally {
      kit.close();
    }
  });

  test("settles at once when the seat already applied that commit", async () => {
    // ACK AFTER DELTA. The change feed does not wait for the HTTP reply, so
    // the applier's in-transaction hook can fire for this commit while the
    // intent is still `sending` — and it never fires for that commit again.
    const kit = harness(
      (intent) => ({
        intentId: intent.intentId,
        status: "executed",
        commitSeq: 7,
      }),
      () => 9
    );
    try {
      await enqueue(kit.queue, "already landed");
      await drainIntents(kit.host);
      await expect(kit.queue.list()).resolves.toStrictEqual([]);
      expect(kit.settled.at(-1)?.state).toBe("executed");
    } finally {
      kit.close();
    }
  });

  test("keeps a seat waiting for a commit it has not reached", async () => {
    const kit = harness(
      (intent) => ({
        intentId: intent.intentId,
        status: "executed",
        commitSeq: 12,
      }),
      () => 11
    );
    try {
      await enqueue(kit.queue, "not yet");
      await drainIntents(kit.host);
      const [record] = await kit.queue.list();
      expect(record?.state).toBe("awaiting-change");
      expect(record?.commitSeq).toBe(12);
    } finally {
      kit.close();
    }
  });
});

describe("an in-flight answer", () => {
  test("parks with nothing to settle against; the retry brings the position", async () => {
    let executed = false;
    const kit = harness((intent) =>
      executed
        ? { intentId: intent.intentId, status: "executed", commitSeq: 3 }
        : { intentId: intent.intentId, status: "in-flight" }
    );
    try {
      await enqueue(kit.queue, "accepted, not committed");
      await drainIntents(kit.host);
      const [parked] = await kit.queue.list();
      expect(parked?.state).toBe("awaiting-change");
      expect(parked?.commitSeq).toBeUndefined();
      // A retry re-queues the head and the gateway's retained outcome answers.
      executed = true;
      await kit.queue.parked(parked!.intentId);
      expect((await kit.queue.list())[0]?.state).toBe("parked");
    } finally {
      kit.close();
    }
  });
});

describe("an executed answer from a gateway older than wave 1", () => {
  test("parks carrying the row versions it named, so #929 can rescue it", async () => {
    const kit = harness((intent) => ({
      intentId: intent.intentId,
      status: "executed",
      answeredVersions: [{ entity: "task", rowId: "task-1", version: 4 }],
    }));
    try {
      await enqueue(kit.queue, "no position");
      await drainIntents(kit.host);
      const [record] = await kit.queue.list();
      expect(record?.state).toBe("awaiting-change");
      expect(record?.commitSeq).toBeUndefined();
      expect(record?.answeredVersions).toStrictEqual([
        { entity: "task", rowId: "task-1", version: 4 },
      ]);
      const [settled] = await kit.queue.settleAnswered(() => true);
      expect(settled?.state).toBe("executed");
    } finally {
      kit.close();
    }
  });
});

describe("a successful send", () => {
  test("retires the transport reason an earlier attempt wrote (R2)", async () => {
    const kit = harness((intent) => ({
      intentId: intent.intentId,
      status: "executed",
      commitSeq: 5,
    }));
    try {
      const intentId = await enqueue(kit.queue, "retried");
      await kit.queue.claimNext();
      await kit.queue.transportFailed(
        intentId,
        "POST /centraid/_vault/replica/intents never left the phone — fetch failed"
      );
      expect((await kit.queue.list())[0]?.reason).toContain("fetch failed");
      await drainIntents(kit.host);
      expect((await kit.queue.list())[0]?.reason).toBeUndefined();
    } finally {
      kit.close();
    }
  });
});

describe("a deep backlog", () => {
  test("drains in one pass without a frame per intent (P23)", async () => {
    const kit = harness((intent) => ({
      intentId: intent.intentId,
      status: "executed",
      commitSeq: 1,
    }));
    try {
      for (let index = 0; index < 400; index += 1)
        // oxlint-disable-next-line no-await-in-loop -- outbox order is the point
        await enqueue(kit.queue, `thought ${index}`);
      await drainIntents(kit.host);
      expect(kit.sent).toHaveLength(400);
      expect(kit.sent[0]).toBe("intent-1");
      expect(kit.sent.at(-1)).toBe("intent-400");
    } finally {
      kit.close();
    }
  }, 30_000);
});
