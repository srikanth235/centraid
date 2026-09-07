// THE RE-BOOTSTRAP, WITH THE MEMBER'S QUEUE STILL IN IT (#996, R23/R25).
//
// A re-bootstrap replaces what the gateway gave this seat. It must not touch
// the three things the gateway has never heard of — the queued intents, their
// ORDER, and the bytes they need — and, while it runs, it must not SEND: the
// cursor is about to move discontinuously, so an outcome arriving mid-repair
// would be reconciled against a copy that no longer exists.
//
// `admissionDuringRebootstrap` states that pair — admit, do not send — and
// before this suite nothing enforced it. `flushIntents` drained straight
// through a repair, and an awaited `write()` during one had no answer at all
// until the drain it should never have started came back.

import { describe, expect, test } from "vitest";

import {
  admissionDuringRebootstrap,
  reconstructPendingProjection,
} from "@centraid/client/replica/native";

import { protectedByPendingWork } from "../../kit/fetch-gate/protections";
import { createNativeReplicaSession } from "./native-session";
import {
  createFeed,
  gatewayAuth,
  json,
  noChanges,
  nodeDigest,
  page,
  sequentialIds,
} from "./native-session.test-fixtures";
import { NodeSqliteDriver } from "./node-sqlite-driver";

/** A gateway whose bootstrap can be held open, so the repair has a duration. */
function pausableGateway() {
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pathnames: string[] = [];
  let pause = false;
  return {
    pathnames,
    hold: () => {
      pause = true;
    },
    release: () => release?.(),
    fetcher: async (
      _baseUrl: string,
      pathname: string,
      _init: RequestInit
    ): Promise<Response> => {
      pathnames.push(pathname);
      if (pathname.includes("/replica/bootstrap")) {
        if (pause) await held;
        return json(page({ epoch: "replica-1", seq: 1 }));
      }
      if (pathname.includes("/changes"))
        return json(noChanges({ epoch: "replica-1", seq: 1 }));
      if (pathname.includes("/replica/intents"))
        return json({ outcome: { intentId: "intent-1", status: "executed" } });
      return new Response("{}", { status: 200 });
    },
  };
}

/**
 * The acceptance row's chain: create, rename twice, due date, complete.
 *
 * Written out rather than looped because the ORDER is the subject — these five
 * are sequential by construction, and a loop over them would be a loop the
 * lint rule is right to object to.
 */
async function queueTaskChain(
  session: Awaited<ReturnType<typeof createNativeReplicaSession>>
): Promise<string[]> {
  const created = await session.write("tasks", {
    action: "tasks.add_task",
    input: { title: "Book the ferry" },
  });
  const renameOne = await session.write("tasks", {
    action: "tasks.rename_task",
    input: { title: "Book the ferry (Tue)" },
  });
  const renameTwo = await session.write("tasks", {
    action: "tasks.rename_task",
    input: { title: "Ferry tickets" },
  });
  const due = await session.write("tasks", {
    action: "tasks.set_due_date",
    input: { due_date: "2026-09-20" },
  });
  const done = await session.write("tasks", {
    action: "tasks.complete_task",
    input: { completed: true },
  });
  return [created, renameOne, renameTwo, due, done].map(
    (result) => result.intentId
  );
}

describe("the seat's re-bootstrap", () => {
  test("admits a write while the copy is being replaced, and does not send it", async () => {
    const gateway = pausableGateway();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => true,
    });
    try {
      gateway.hold();
      session.requireBootstrap();
      const admitted = await session.write("photos", {
        action: "photos.favorite",
        input: { assetId: "asset-1", favorite: true },
      });
      // Saved, in as many words — refusing here would make "saved" untrue
      // during a repair the member did not ask for and cannot see.
      expect(admitted).toMatchObject({
        status: "queued",
        reason: admissionDuringRebootstrap().reason,
      });
      expect(admissionDuringRebootstrap().send).toBe(false);
      expect(
        gateway.pathnames.filter((path) => path.includes("/replica/intents"))
      ).toStrictEqual([]);
    } finally {
      gateway.release();
      await session.close();
    }
  });

  test("carries the whole chain across the repair, in the order it was made", async () => {
    const gateway = pausableGateway();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => false,
    });
    try {
      const ids = await queueTaskChain(session);
      gateway.hold();
      session.requireBootstrap();

      const carried = await session.coordinator.intents.list();
      expect(carried.map((intent) => intent.intentId)).toStrictEqual(ids);
      // VERBATIM: the order of the queue is part of the queue (R23). A repair
      // that renumbers it reorders the member's work.
      expect(carried.map((intent) => intent.createdOrder)).toStrictEqual([
        1, 2, 3, 4, 5,
      ]);
      // And the INPUTS verbatim, which is what the overlay is rebuilt from
      // (`reconstructPendingProjection` reads this same list). These five were
      // admitted before any bootstrap, so their projections are deferred until
      // page one supplies the catalog — the durable act is the input, and a
      // repair that kept the row but lost the title would be the same loss.
      expect(carried.map((intent) => intent.input)).toStrictEqual([
        { title: "Book the ferry" },
        { title: "Book the ferry (Tue)" },
        { title: "Ferry tickets" },
        { due_date: "2026-09-20" },
        { completed: true },
      ]);
      expect(reconstructPendingProjection(carried)).toStrictEqual([]);
    } finally {
      gateway.release();
      await session.close();
    }
  });

  test("publishes the content its queue needs, and withdraws it on close", async () => {
    const gateway = pausableGateway();
    const session = await createNativeReplicaSession({
      gatewayAuth,
      fetcher: gateway.fetcher,
      changeFeed: createFeed(),
      driver: new NodeSqliteDriver(),
      digest: nodeDigest,
      idFactory: sequentialIds(),
      isConnected: () => false,
    });
    const ref = { scopeId: "vault-a", contentId: "content-staged" };
    try {
      await session.write("photos", {
        action: "photos.add_caption",
        input: { content_id: "content-staged", caption: "the ferry" },
      });
      // The LRU may not delete the one copy of bytes the member's own queued
      // write is waiting on (R25).
      expect(protectedByPendingWork(ref)).toBe(true);
    } finally {
      await session.close();
    }
    // A closed seat's queue is no longer a reason to keep anything.
    expect(protectedByPendingWork(ref)).toBe(false);
  });
});
