import { describe, expect, test } from "vitest";

import { effectIdFor, reduceEdge } from "./share-coordinator.js";
import type { EdgeFacts, EdgeSignal, EdgeState } from "./share-coordinator.js";

const ADD: EdgeFacts = { edgeId: "edge-1", kind: "add" };
const MOVE: EdgeFacts = { ...ADD, kind: "move" };

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

describe("reduceEdge — one lifecycle for the placement plane", () => {
  test("begin emits exactly one deliver-give effect", () => {
    for (const facts of [ADD, MOVE]) {
      const outcome = reduceEdge(facts, queued(), { type: "begin" });
      expect(outcome.state.status).toBe("in-flight");
      expect(outcome.effects).toStrictEqual([
        { kind: "deliver-give", edgeId: facts.edgeId },
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
    const half = queued({ status: "in-flight", targetState: "executed" });
    expect(
      reduceEdge(MOVE, { ...half, sourceState: "queued" }, { type: "settled" })
        .changed
    ).toBe(false);
  });

  test("a terminal edge absorbs every later signal", () => {
    const completed = reduceEdge(ADD, queued(), {
      type: "target-projected",
      targetItemIds: ["x"],
    }).state;
    expect(completed.status).toBe("completed");
    for (const signal of [
      { type: "begin" },
      { type: "target-projected", targetItemIds: ["y"] },
      { type: "settled" },
      { type: "give-failed", reason: "late" },
    ] satisfies EdgeSignal[]) {
      expect(reduceEdge(ADD, completed, signal).changed).toBe(false);
    }
  });

  test("a parked edge stays retryable — parked is not terminal", () => {
    const parked = reduceEdge(ADD, queued({ status: "in-flight" }), {
      type: "give-failed",
      reason: "the audience vault is not open here",
    });
    expect(parked.state.status).toBe("parked");
    expect(
      reduceEdge(ADD, parked.state, {
        type: "give-failed",
        reason: "the audience vault is not open here",
      }).changed
    ).toBe(false);
    expect(
      reduceEdge(ADD, parked.state, {
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
    expect(effectIdFor({ kind: "deliver-give", edgeId: "e" })).toBe("give:e");
  });
});
