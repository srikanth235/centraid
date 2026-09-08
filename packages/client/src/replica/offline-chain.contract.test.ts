//
// Three outboxes exist since W5 — an in-memory one, the seat's SQLite table,
// and that same table across the browser's WORKER BOUNDARY — and the chain has
// to behave identically on all three. It is one contract, not three suites,
// because the difference that matters (a store that shares a transaction with
// the rows it is about, and a proxy that reaches it at a distance) is exactly
// the difference that would otherwise hide a divergence.
//
// THE INDEXEDDB BACKEND IS GONE, with the store itself. The browser's outbox
// was a separate database beside the replica, which is why R24's central
// promise — an executed answer clearing its overlay IN THE TRANSACTION THAT
// CARRIES ITS COMMIT — could not be expressed there and had to be reconciled
// across two stores with a window in between. The seat's file is one store.

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { stablePendingRowId } from "@centraid/blueprints/apps/_shared/pending-overlay";

import type { IntentRecordStore } from "./intent-record-store.js";
import { IntentQueue } from "./intents.js";
import { MemoryIntentStore } from "./memory-intent-store.js";
import {
  absenceReconciled,
  chainBadgeCopy,
  chainDependencies,
  chainHolds,
  chainNextRetryAt,
  chainRecoveryFromExpiredOutcome,
  chainRetryDelayMs,
  mintedRowIndex,
  overlaysClearedAt,
  reconstructPendingProjection,
  SEAT_REBOOTSTRAP_CUTOVER,
  admissionDuringRebootstrap,
  substitutePredecessorReferences,
} from "./offline-chain.js";
import { ReplicaIntentRecoveryError } from "./replica-intent-recovery-error.js";
import { ReplicaRebootstrapRequiredError } from "./replica-rebootstrap-error.js";
import { openSeatFile } from "./seat/driver.js";
import { inlineMemorySeatWorker } from "./seat/inline-seat-worker.test-fixtures.js";
import { NodeSeatDriver } from "./seat/node-seat-driver.js";
import { SeatIntentStore } from "./seat/seat-intent-store.js";
import { SeatWorkerClient } from "./seat/seat-worker-client.js";
import { SeatWorkerOutbox } from "./seat/seat-worker-outbox.js";
import { postReplicaIntent } from "./shell-transport.js";
import type { ReplicaFetcher } from "./shell-transport.js";
import type { OptimisticMutation, ReplicaIntent } from "./types.js";

interface Backend {
  readonly name: string;
  readonly open: () => Promise<{
    store: IntentRecordStore;
    dispose: () => void;
  }>;
}

const BACKENDS: readonly Backend[] = [
  {
    name: "memory",
    open: () =>
      Promise.resolve({
        store: new MemoryIntentStore(),
        dispose: () => undefined,
      }),
  },
  {
    name: "sqlite",
    open: () => {
      const driver = new NodeSeatDriver();
      openSeatFile(driver);
      return Promise.resolve({
        store: SeatIntentStore.create(driver),
        dispose: () => driver.close(),
      });
    },
  },
  {
    // THE SAME SQLITE OUTBOX, ACROSS THE WORKER BOUNDARY (#996, R24). This is
    // the browser's arrangement: the seat's file — and therefore its outbox —
    // is behind a `postMessage`, because the applier walks hundreds of
    // thousands of rows and must not do that on the thread that paints. The
    // chain must not be able to tell.
    name: "seat-worker",
    open: async () => {
      const { worker, close } = inlineMemorySeatWorker();
      const client = new SeatWorkerClient(worker);
      await client.open({
        vaultId: "vault-1",
        dbName: "/seat.db",
        remember: true,
      });
      return {
        store: new SeatWorkerOutbox(client),
        dispose: () => {
          void client.close();
          close();
        },
      };
    },
  },
];

/** The task the chain is about, projected the way an app's projection does. */
function taskUpsert(
  intentId: string,
  values: Record<string, unknown>
): OptimisticMutation {
  return {
    op: "upsert",
    shapeId: "shape-tasks",
    entity: "schedule.task",
    rowId: stablePendingRowId(intentId, "task"),
    values: { task_id: stablePendingRowId(intentId, "task"), ...values },
  };
}

let counter = 0;
function queueOver(store: IntentRecordStore): IntentQueue {
  counter = 0;
  return new IntentQueue(store, {
    // THE CONTRACT DRIVES THE CURSOR ITSELF, over all three outboxes: the
    // question here is whether the CHAIN behaves the same given one, not which
    // hosts happen to have one wired (#996, R24 — see `intent-settlement.ts`).
    settlesByCommitSeq: true,
    idFactory: () => `intent-${(counter += 1)}`,
    digest: (canonical) =>
      Promise.resolve(`digest:${canonical.length}:${canonical}`),
  });
}

/** The five-intent chain from the acceptance row, queued offline. */
async function airplaneModeChain(queue: IntentQueue): Promise<ReplicaIntent[]> {
  const create = await queue.enqueue({
    appId: "tasks",
    action: "tasks.add_task",
    input: { title: "Book the ferry" },
    optimistic: [taskUpsert("intent-1", { title: "Book the ferry" })],
  });
  const taskRow = stablePendingRowId("intent-1", "task");
  const renameOne = await queue.enqueue({
    appId: "tasks",
    action: "tasks.rename_task",
    input: { task_id: taskRow, title: "Book the ferry (Tue)" },
    optimistic: [taskUpsert("intent-1", { title: "Book the ferry (Tue)" })],
  });
  const renameTwo = await queue.enqueue({
    appId: "tasks",
    action: "tasks.rename_task",
    input: { task_id: taskRow, title: "Ferry tickets" },
    optimistic: [taskUpsert("intent-1", { title: "Ferry tickets" })],
  });
  const due = await queue.enqueue({
    appId: "tasks",
    action: "tasks.set_due",
    input: { task_id: taskRow, due_at: "2026-03-01" },
    optimistic: [taskUpsert("intent-1", { due_at: "2026-03-01" })],
  });
  const complete = await queue.enqueue({
    appId: "tasks",
    action: "tasks.complete",
    input: { task_id: taskRow },
    optimistic: [taskUpsert("intent-1", { status: "done" })],
  });
  return [create, renameOne, renameTwo, due, complete];
}

describe.each(BACKENDS)(
  "the offline chain over the $name outbox",
  (backend) => {
    let opened: { store: IntentRecordStore; dispose: () => void };

    beforeEach(async () => {
      opened = await backend.open();
    });
    afterEach(() => {
      opened.dispose();
    });

    test("orders the chain and names each predecessor exactly once", async () => {
      const queue = queueOver(opened.store);
      const chain = await airplaneModeChain(queue);
      expect(chain.map((intent) => intent.createdOrder)).toStrictEqual([
        1, 2, 3, 4, 5,
      ]);
      // Every dependent names the CREATE, and only the create: the renames do
      // not chain off each other, because a rename mints nothing.
      expect(chain.map((intent) => intent.dependsOn ?? [])).toStrictEqual([
        [],
        ["intent-1"],
        ["intent-1"],
        ["intent-1"],
        ["intent-1"],
      ]);
      // The row id the projection invented never reaches the wire as a value.
      for (const intent of chain.slice(1)) {
        expect(intent.input).toMatchObject({
          task_id: { $intent: "intent-1", table: "schedule.task" },
        });
      }
      // The chain is part of the payload, so a dependent's hash is not the hash
      // the same payload would have had without it.
      expect(chain[1]!.payloadHash).toContain("dependsOn");
    });

    test("holds the dependents behind the create, with the copy a member reads", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      const holds = chainHolds(await opened.store.list());
      expect(holds.map((hold) => hold.intentId)).toStrictEqual([
        "intent-2",
        "intent-3",
        "intent-4",
        "intent-5",
      ]);
      expect(holds.every((hold) => hold.kind === "waiting")).toBe(true);
      expect(chainBadgeCopy(holds[0]!)).toBe("Waiting on an earlier change");
    });

    test("a rejected creation abandons its dependents, naming what refused it", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      await opened.store.transition("intent-1", ["queued"], {
        state: "sending",
      });
      await queue.applyOutcomes([
        {
          intentId: "intent-1",
          status: "denied",
          reason: "this list is read-only for you",
        },
      ]);
      const holds = chainHolds(await opened.store.list());
      expect(holds.every((hold) => hold.kind === "abandoned")).toBe(true);
      expect(chainBadgeCopy(holds[0]!)).toBe(
        "An earlier change did not go through — this list is read-only for you"
      );
      // Nothing was sent: the dependents are still queued, so a retry of the
      // create releases them rather than needing them re-made.
      const states = (await opened.store.list()).map((intent) => intent.state);
      expect(new Set(states.slice(1))).toStrictEqual(new Set(["queued"]));
    });

    test("another writer's unrelated intent keeps draining while the chain is held", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      const note = await queue.enqueue({
        appId: "notes",
        action: "notes.rename_note",
        input: { note_id: "canonical-note-1", title: "Packing list" },
        optimistic: [
          {
            op: "upsert",
            shapeId: "shape-notes",
            entity: "knowledge.note",
            rowId: "canonical-note-1",
            values: { title: "Packing list" },
          },
        ],
      });
      // It names a CANONICAL row, so it depends on nothing and is held by
      // nothing — one conflicted task never holds an unrelated note.
      expect(note.dependsOn).toBeUndefined();
      expect(
        chainHolds(await opened.store.list()).some(
          (hold) => hold.intentId === note.intentId
        )
      ).toBe(false);
    });

    test("a lost acknowledgement replays the retained outcome without a second effect", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      await opened.store.transition("intent-1", ["queued"], {
        state: "sending",
      });
      // The gateway committed; the answer was lost; the seat retried and got the
      // SAME outcome back, carrying its commit position.
      await queue.applyOutcomes([
        { intentId: "intent-1", status: "executed", commitSeq: 41 },
      ]);
      const held = await opened.store.get("intent-1");
      expect(held).toMatchObject({ state: "awaiting-change", commitSeq: 41 });
      // Replaying the identical answer changes nothing.
      await queue.applyOutcomes([
        { intentId: "intent-1", status: "executed", commitSeq: 41 },
      ]);
      await expect(opened.store.get("intent-1")).resolves.toMatchObject({
        state: "awaiting-change",
        commitSeq: 41,
      });
    });

    test("acknowledgement before delta: the overlay clears when the cursor arrives", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      await opened.store.transition("intent-1", ["queued"], {
        state: "sending",
      });
      await queue.applyOutcomes([
        { intentId: "intent-1", status: "executed", commitSeq: 41 },
      ]);
      // The answer is in and the rows are not: the pending row still shows.
      expect(
        (await queue.pending()).some((intent) => intent.intentId === "intent-1")
      ).toBe(true);
      expect(overlaysClearedAt(40, await opened.store.list())).toStrictEqual(
        []
      );
      await expect(queue.settleAtCommitSeq(40)).resolves.toStrictEqual([]);
      // The cursor reaches the commit; the overlay goes.
      expect(overlaysClearedAt(41, await opened.store.list())).toStrictEqual([
        "intent-1",
      ]);
      const settled = await queue.settleAtCommitSeq(41);
      expect(settled.map((intent) => intent.intentId)).toStrictEqual([
        "intent-1",
      ]);
      await expect(opened.store.get("intent-1")).resolves.toBeUndefined();
    });

    test("delta before acknowledgement converges to the same place", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      await opened.store.transition("intent-1", ["queued"], {
        state: "sending",
      });
      // The rows arrived first. Nothing is awaiting-change yet, so the cursor
      // pass is a no-op rather than an error…
      await expect(queue.settleAtCommitSeq(41)).resolves.toStrictEqual([]);
      // …and the answer, when it lands, settles at once because the cursor is
      // already past it.
      await queue.applyOutcomes([
        { intentId: "intent-1", status: "executed", commitSeq: 41 },
      ]);
      const settled = await queue.settleAtCommitSeq(41);
      expect(settled.map((intent) => intent.intentId)).toStrictEqual([
        "intent-1",
      ]);
    });

    test("an accepted deletion and a rejected creation both reconcile to absence", async () => {
      const queue = queueOver(opened.store);
      const created = await queue.enqueue({
        appId: "tasks",
        action: "tasks.add_task",
        input: { title: "Refused" },
        optimistic: [taskUpsert("intent-1", { title: "Refused" })],
      });
      const removed = await queue.enqueue({
        appId: "tasks",
        action: "tasks.delete_task",
        input: { task_id: "canonical-task-9" },
        optimistic: [
          {
            op: "delete",
            shapeId: "shape-tasks",
            entity: "schedule.task",
            rowId: "canonical-task-9",
          },
        ],
      });
      // A refusal produced no commit, so there is nothing to wait for.
      expect(absenceReconciled({ state: "denied" }, 0)).toBe(true);
      expect(absenceReconciled({ state: "queued" }, 99)).toBe(false);
      // A delete waits for its commit like every other executed answer.
      expect(absenceReconciled({ state: "executed", commitSeq: 50 }, 49)).toBe(
        false
      );
      expect(absenceReconciled({ state: "executed", commitSeq: 50 }, 50)).toBe(
        true
      );
      expect(created.intentId).toBe("intent-1");
      // A delete names a canonical row, so it never becomes a dependent.
      expect(removed.dependsOn).toBeUndefined();
    });

    test("a restart rebuilds the overlay from the outbox, in outbox order", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      // "The app was killed": nothing is held in memory, the outbox is read back.
      const projection = reconstructPendingProjection(
        await opened.store.list()
      );
      expect(projection).toHaveLength(5);
      // One task, and the LAST writer of each field wins — the screen shows one
      // completed task with the final values, exactly as before the restart.
      const merged = projection.reduce<Record<string, unknown>>(
        (row, mutation) =>
          mutation.op === "upsert" ? { ...row, ...mutation.values } : row,
        {}
      );
      expect(merged).toMatchObject({
        title: "Ferry tickets",
        due_at: "2026-03-01",
        status: "done",
      });
      expect(new Set(projection.map((mutation) => mutation.rowId)).size).toBe(
        1
      );
    });

    test("an intent admitted during re-bootstrap preparation is saved and held", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      const admission = admissionDuringRebootstrap();
      expect(admission).toMatchObject({ admit: true, send: false });
      // Admission is a durable local fact even mid-repair: "saved" must not
      // become untrue because of something the member cannot see.
      const late = await queue.enqueue({
        appId: "notes",
        action: "notes.create_note",
        input: { title: "Written during the swap" },
        optimistic: [],
      });
      await expect(opened.store.get(late.intentId)).resolves.toMatchObject({
        state: "queued",
      });
      expect(SEAT_REBOOTSTRAP_CUTOVER[1]).toContain("carry-over");
      expect(SEAT_REBOOTSTRAP_CUTOVER[2]).toContain("install");
    });

    test("a snapshot already holding an unacknowledged intent does not re-run it", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      await opened.store.transition("intent-1", ["queued"], {
        state: "sending",
      });
      // The seat re-bootstrapped, and the new file ALREADY contains the create's
      // effect: the snapshot was taken at seq 60, past the commit at 41.
      await queue.applyOutcomes([
        { intentId: "intent-1", status: "executed", commitSeq: 41 },
      ]);
      const settled = await queue.settleAtCommitSeq(60);
      expect(settled.map((intent) => intent.intentId)).toStrictEqual([
        "intent-1",
      ]);
      // And it is gone from the queue, so nothing sends it a second time.
      await expect(opened.store.get("intent-1")).resolves.toBeUndefined();
      expect(
        (await opened.store.list()).map((intent) => intent.intentId)
      ).toStrictEqual(["intent-2", "intent-3", "intent-4", "intent-5"]);
    });

    test("a transport failure holds the head and schedules its own retry", async () => {
      const queue = queueOver(opened.store);
      await airplaneModeChain(queue);
      const claimed = await queue.claimNext();
      expect(claimed?.intentId).toBe("intent-1");
      await queue.transportFailed("intent-1", "offline");
      // The head is back at the front, not skipped: the chain drains in order.
      expect((await queue.claimNext())?.intentId).toBe("intent-1");
      expect(chainRetryDelayMs(0)).toBe(1_000);
      expect(chainRetryDelayMs(3)).toBe(8_000);
      expect(chainRetryDelayMs(30)).toBe(300_000);
      expect(
        chainNextRetryAt({ attempts: 1 }, new Date("2026-01-01T00:00:00.000Z"))
      ).toBe("2026-01-01T00:00:02.000Z");
    });
  }
);

describe("what the chain derives, without an outbox", () => {
  test("an app-supplied id stays a value; an invented one becomes a reference", () => {
    const minted = mintedRowIndex([
      {
        intentId: "intent-supplied",
        payloadHash: "h",
        appId: "tasks",
        action: "tasks.add_task",
        input: { task_id: "app-chose-this" },
        state: "queued",
        createdOrder: 1,
        attempts: 0,
        optimistic: [
          {
            op: "upsert",
            shapeId: "s",
            entity: "schedule.task",
            rowId: "app-chose-this",
            values: {},
          },
        ],
      },
    ]);
    // The app supplied the id, so the create will write it and every later
    // intent may name it directly.
    expect(minted.get("app-chose-this")?.synthetic).toBe(false);
    expect(
      substitutePredecessorReferences({ task_id: "app-chose-this" }, minted)
    ).toStrictEqual({ task_id: "app-chose-this" });
    // The edge still exists: the row does not yet, whoever chose its id.
    expect(
      chainDependencies({ task_id: "app-chose-this" }, minted)
    ).toStrictEqual(["intent-supplied"]);
  });

  test("a settled predecessor is no longer a dependency", () => {
    const minted = mintedRowIndex([
      {
        intentId: "intent-done",
        payloadHash: "h",
        appId: "tasks",
        action: "tasks.add_task",
        input: {},
        state: "executed",
        createdOrder: 1,
        attempts: 0,
        optimistic: [
          {
            op: "upsert",
            shapeId: "s",
            entity: "schedule.task",
            rowId: "row-1",
            values: {},
          },
        ],
      },
    ]);
    expect(minted.size).toBe(0);
    expect(chainDependencies({ task_id: "row-1" }, minted)).toStrictEqual([]);
  });

  test("an expired outcome is a decision for the member, never a silent retry", () => {
    const recovery = chainRecoveryFromExpiredOutcome({
      error: "replica_intent_outcome_expired",
      recovery: "resubmit-as-new-intent",
      reason: "the gateway can no longer prove whether it ran",
    });
    expect(recovery).toMatchObject({ action: "recover", mintNewIntent: true });
    expect(recovery.copy).toContain("send it again");
  });
});

describe("a 409 about one intent is not a 409 about the copy", () => {
  const answering =
    (body: unknown, status: number): ReplicaFetcher =>
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });

  const sending = (overrides: Partial<ReplicaIntent> = {}): ReplicaIntent => ({
    intentId: "intent-1",
    payloadHash: "h",
    appId: "tasks",
    action: "tasks.complete",
    input: {},
    state: "sending",
    createdOrder: 1,
    attempts: 2,
    optimistic: [],
    ...overrides,
  });

  const auth = { baseUrl: "https://gateway.test", token: "t" };

  test("an expired outcome surfaces as recover, never as re-bootstrap", async () => {
    const failure = await postReplicaIntent(
      auth,
      sending(),
      answering(
        {
          error: "replica_intent_outcome_expired",
          intentId: "intent-1",
          recovery: "resubmit-as-new-intent",
          reason: "the gateway can no longer prove whether it ran",
        },
        409
      )
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ReplicaIntentRecoveryError);
    expect(failure).not.toBeInstanceOf(ReplicaRebootstrapRequiredError);
    const recovery = (failure as ReplicaIntentRecoveryError).recovery;
    expect((failure as ReplicaIntentRecoveryError).intentId).toBe("intent-1");
    expect(recovery.action).toBe("recover");
    expect(recovery.mintNewIntent).toBe(true);
  });

  test("a reused id with different bytes is the same kind of answer", async () => {
    const failure = await postReplicaIntent(
      auth,
      sending(),
      answering(
        { error: "replica_intent_payload_mismatch", intentId: "intent-1" },
        409
      )
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ReplicaIntentRecoveryError);
  });

  test("a stale cursor is still a re-bootstrap", async () => {
    const failure = await postReplicaIntent(
      auth,
      sending(),
      answering({ error: "replica_epoch_mismatch" }, 409)
    ).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(ReplicaRebootstrapRequiredError);
  });

  test("the chain goes on the wire with the intent", async () => {
    const bodies: string[] = [];
    await postReplicaIntent(
      auth,
      sending({
        intentId: "intent-2",
        action: "tasks.rename_task",
        input: { task_id: { $intent: "intent-1" } },
        createdOrder: 2,
        attempts: 1,
        dependsOn: ["intent-1"],
      }),
      async (_base, _path, init) => {
        bodies.push(String(init?.body));
        return new Response(
          JSON.stringify({
            outcome: { intentId: "intent-2", status: "in-flight" },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );
    expect(JSON.parse(bodies[0]!)).toMatchObject({ dependsOn: ["intent-1"] });
  });
});
