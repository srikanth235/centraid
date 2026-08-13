/*
 * The edge lifecycle's legal transitions, as one table (#750 abstraction 5).
 * These are pure-function tests on purpose: before this reducer existed the
 * same questions could only be asked through a route, a database and a
 * transport, which is why four files could disagree about them.
 *
 * The two transports' behaviour over the SAME transitions is pinned by
 * `peer-remote-give.test.ts` (peer) and `edges-routes.test.ts` (local).
 */

import { describe, expect, test } from "vitest";

import { effectIdFor, reduceEdge } from "./share-coordinator.js";
import type { EdgeFacts, EdgeSignal, EdgeState } from "./share-coordinator.js";

const ADD: EdgeFacts = {
  edgeId: "edge-1",
  kind: "add",
  delivery: "local",
  crossOwner: false,
};
const MOVE: EdgeFacts = { ...ADD, kind: "move" };
const PEER: EdgeFacts = { ...ADD, delivery: "peer", crossOwner: true };

function queued(overrides: Partial<EdgeState> = {}): EdgeState {
  return {
    status: "queued",
    targetState: "queued",
    sourceState: "not-needed",
    targetItemIds: null,
    reason: null,
    ...overrides,
  };
}

describe("reduceEdge — one lifecycle for both localities", () => {
  test("begin emits exactly one deliver-give effect, whatever the locality", () => {
    for (const facts of [ADD, PEER]) {
      const outcome = reduceEdge(facts, queued(), { type: "begin" });
      expect(outcome.state.status).toBe("in-flight");
      expect(outcome.effects).toStrictEqual([
        {
          kind: "deliver-give",
          edgeId: facts.edgeId,
          delivery: facts.delivery,
          crossOwner: facts.crossOwner,
        },
      ]);
    }
  });

  test("an add completes on projection; a move waits for its source", () => {
    const projected: EdgeSignal = {
      type: "target-projected",
      targetItemIds: ["item-1"],
    };
    const add = reduceEdge(ADD, queued({ status: "in-flight" }), projected);
    expect(add.state.status).toBe("completed");
    expect(add.state.targetItemIds).toStrictEqual(["item-1"]);

    const move = reduceEdge(
      MOVE,
      queued({ status: "in-flight", sourceState: "queued" }),
      projected
    );
    // The audience projection ALWAYS commits before the source is released.
    expect(move.state.status).toBe("in-flight");
    expect(move.state.targetState).toBe("executed");
    const released = reduceEdge(MOVE, move.state, { type: "source-released" });
    expect(released.state.status).toBe("completed");
  });

  test("replaying a projection changes nothing (crash-resume is a no-op)", () => {
    const once = reduceEdge(MOVE, queued({ sourceState: "queued" }), {
      type: "target-projected",
      targetItemIds: ["item-1"],
    });
    const after = reduceEdge(MOVE, once.state, { type: "source-released" });
    const replayed = reduceEdge(MOVE, after.state, {
      type: "target-projected",
      targetItemIds: ["item-1", "item-2"],
    });
    expect(replayed.changed).toBe(false);
    // Crucially: the replay does NOT undo the source release that followed.
    expect(replayed.state.sourceState).toBe("executed");
    expect(replayed.state.targetItemIds).toStrictEqual(["item-1"]);
  });

  test("settled resumes an edge whose work was already done", () => {
    const both = queued({
      status: "in-flight",
      targetState: "executed",
      sourceState: "executed",
    });
    expect(reduceEdge(MOVE, both, { type: "settled" }).state.status).toBe(
      "completed"
    );
    // Half-done stays half-done — `settled` never invents completion.
    const half = queued({ status: "in-flight", targetState: "executed" });
    expect(
      reduceEdge(MOVE, { ...half, sourceState: "queued" }, { type: "settled" })
        .changed
    ).toBe(false);
  });

  test("a refusal is a state, and a terminal edge absorbs later signals", () => {
    const denied = reduceEdge(PEER, queued({ status: "parked" }), {
      type: "give-denied",
      reason: "recipient declined this share",
    });
    expect(denied.state.status).toBe("denied");
    // A late-arriving retry of the same relay clobbers nothing.
    for (const signal of [
      { type: "begin" },
      { type: "target-projected", targetItemIds: ["x"] },
      { type: "give-denied", reason: "again" },
    ] satisfies EdgeSignal[]) {
      expect(reduceEdge(PEER, denied.state, signal).changed).toBe(false);
    }
    const completed = reduceEdge(ADD, queued(), {
      type: "target-projected",
      targetItemIds: ["x"],
    }).state;
    expect(
      reduceEdge(ADD, completed, { type: "give-denied", reason: "late" })
        .changed
    ).toBe(false);
  });

  test("an ask and an unreachable peer both park, and stay retryable", () => {
    const asked = reduceEdge(PEER, queued({ status: "in-flight" }), {
      type: "give-asked",
    });
    expect(asked.state.status).toBe("parked");
    expect(asked.state.reason).toBe("awaiting recipient decision");
    const parked = reduceEdge(PEER, asked.state, {
      type: "give-parked",
      reason: "peer unreachable: offline",
    });
    expect(parked.state.status).toBe("parked");
    // Parked is NOT terminal — a later attempt may still complete the edge.
    expect(
      reduceEdge(PEER, parked.state, {
        type: "target-projected",
        targetItemIds: ["x"],
      }).state.status
    ).toBe("completed");
  });

  test("a local vault failure parks rather than claiming finality", () => {
    const failed = reduceEdge(ADD, queued({ status: "in-flight" }), {
      type: "give-failed",
      reason: "disk is full",
    });
    expect(failed.state.status).toBe("parked");
    expect(failed.state.reason).toBe("disk is full");
  });

  test("revocation reaches even a completed edge", () => {
    const completed = reduceEdge(ADD, queued(), {
      type: "target-projected",
      targetItemIds: ["x"],
    }).state;
    const revoked = reduceEdge(ADD, completed, {
      type: "revoked",
      reason: "the owner withdrew access",
    });
    expect(revoked.state.status).toBe("revoked");
    expect(
      reduceEdge(ADD, revoked.state, { type: "revoked", reason: "x" }).changed
    ).toBe(false);
  });

  test("effect ids are derived, so a replay lands on the same row", () => {
    expect(
      effectIdFor({
        kind: "deliver-give",
        edgeId: "e",
        delivery: "peer",
        crossOwner: true,
      })
    ).toBe("give:e");
    expect(
      effectIdFor({
        kind: "pull-blob",
        edgeId: "e",
        linkId: "l",
        localVaultId: "v",
        sha256: "abc",
        size: 1,
        tmpPath: "/tmp/x",
      })
    ).toBe("pull:e:abc");
  });
});
