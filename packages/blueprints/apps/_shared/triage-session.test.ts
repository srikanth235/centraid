import { describe, expect, it } from "vitest";

import {
  openTriage,
  triageAnswer,
  triageCurrent,
  triageProgress,
  triageRefill,
  triageSkip,
} from "./triage-session.ts";

const QUEUE = ["a", "b", "c"];

describe("triage session", () => {
  it("walks one item at a time", () => {
    const session = openTriage(QUEUE);
    expect(triageCurrent(session)).toBe("a");
    expect(triageCurrent(triageSkip(session))).toBe("b");
  });

  it("skip records nothing and wraps, so a skipped item genuinely stays in the queue", () => {
    let session = openTriage(QUEUE);
    session = triageSkip(triageSkip(triageSkip(session)));
    expect(triageCurrent(session)).toBe("a");
    expect(triageProgress(session).answered).toBe(0);
    expect(triageProgress(session).position).toBe(1);
  });

  it("an answer counts by outcome and moves on", () => {
    let session = openTriage(QUEUE);
    session = triageAnswer(session, "confirm");
    session = triageAnswer(session, "dismiss");
    expect(triageCurrent(session)).toBe("c");
    expect(session.counts).toStrictEqual({ confirm: 1, dismiss: 1 });
    expect(triageProgress(session).answered).toBe(2);
    expect(triageProgress(session).position).toBe(3);
  });

  it("answering the last item finishes the session — the zero-remaining state is reachable", () => {
    let session = openTriage(["only"]);
    session = triageAnswer(session, "reject");
    expect(triageCurrent(session)).toBeUndefined();
    expect(triageProgress(session).done).toBe(true);
    expect(triageProgress(session).remaining).toBe(0);
  });

  it("the denominator is frozen at open, so the numerator counts UP as the queue shrinks", () => {
    let session = openTriage(QUEUE);
    session = triageAnswer(session, "confirm");
    session = triageRefill(session, ["b", "c"]);
    expect(triageProgress(session)).toMatchObject({ position: 2, total: 3 });
    session = triageAnswer(session, "confirm");
    session = triageRefill(session, ["c"]);
    expect(triageProgress(session)).toMatchObject({ position: 3, total: 3 });
  });

  it("a bounded page can name the true backlog as its denominator", () => {
    const session = openTriage(QUEUE, { total: 54 });
    expect(triageProgress(session)).toMatchObject({ position: 1, total: 54 });
  });

  it("refill keeps the counts and returns to the head of the new queue", () => {
    let session = openTriage(QUEUE);
    session = triageSkip(session);
    session = triageAnswer(session, "reject");
    session = triageRefill(session, ["x", "y"]);
    expect(triageCurrent(session)).toBe("x");
    expect(session.counts).toStrictEqual({ reject: 1 });
  });

  it("a requested position outside the new queue lands on its head, never on nothing", () => {
    const session = triageRefill(openTriage(QUEUE), ["x"], { at: 7 });
    expect(triageCurrent(session)).toBe("x");
  });

  it("an empty queue is finished, not a crash", () => {
    const session = openTriage<string>([]);
    expect(triageCurrent(session)).toBeUndefined();
    expect(triageCurrent(triageSkip(session))).toBeUndefined();
    expect(triageProgress(session)).toMatchObject({
      done: true,
      position: 1,
      total: 1,
    });
  });
});
