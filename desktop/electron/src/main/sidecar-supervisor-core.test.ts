import { describe, expect, it } from "vitest";

import {
  backoffForAttempt,
  BACKOFF_SCHEDULE_MS,
  claimManualRetry,
  claimRevival,
  classifyExit,
  crashLoopMessage,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  initialSupervisorState,
  MANUAL_RETRY_FLOOR_MS,
  MAX_REVIVALS,
  mayRevive,
  MIN_REVIVAL_INTERVAL_MS,
  quitSequence,
  recordFailure,
  recordSuccess,
  REVIVAL_WINDOW_MS,
  TERMINATE_GRACE_MS,
} from "./sidecar-supervisor-core.js";

describe("backoff", () => {
  it("walks the schedule and then holds at its last step", () => {
    expect(backoffForAttempt(1)).toBe(BACKOFF_SCHEDULE_MS[0]);
    expect(backoffForAttempt(2)).toBe(BACKOFF_SCHEDULE_MS[1]);
    expect(backoffForAttempt(3)).toBe(BACKOFF_SCHEDULE_MS[2]);
    expect(backoffForAttempt(99)).toBe(BACKOFF_SCHEDULE_MS[2]);
    // A zero or negative attempt is the first attempt, not an index of -1.
    expect(backoffForAttempt(0)).toBe(BACKOFF_SCHEDULE_MS[0]);
    expect(backoffForAttempt(-5)).toBe(BACKOFF_SCHEDULE_MS[0]);
  });
});

describe("the crash-loop latch", () => {
  it("latches at the threshold inside the window", () => {
    let state = initialSupervisorState();
    expect(state.loopBroken).toBe(false);
    for (let attempt = 1; attempt < CRASH_LOOP_THRESHOLD; attempt += 1) {
      state = recordFailure(state, attempt * 1000, `attempt ${attempt}`);
      expect(state.loopBroken).toBe(false);
    }
    state = recordFailure(state, CRASH_LOOP_THRESHOLD * 1000, "the last one");
    expect(state.loopBroken).toBe(true);
    expect(state.attempt).toBe(CRASH_LOOP_THRESHOLD);
    expect(state.lastError).toBe("the last one");
  });

  it("forgets failures that fell out of the window", () => {
    let state = initialSupervisorState();
    state = recordFailure(state, 0, "old");
    state = recordFailure(state, 1000, "old");
    // Far enough ahead that both earlier failures are outside the window.
    state = recordFailure(state, CRASH_LOOP_WINDOW_MS + 2000, "fresh");
    expect(state.failures).toHaveLength(1);
    expect(state.loopBroken).toBe(false);
  });

  it("clears completely on a success", () => {
    let state = initialSupervisorState();
    state = recordFailure(state, 0, "boom");
    state = recordFailure(state, 1, "boom");
    state = recordFailure(state, 2, "boom");
    expect(state.loopBroken).toBe(true);
    expect(recordSuccess()).toStrictEqual(initialSupervisorState());
  });

  it("quotes the count, the window and the last error on the error screen", () => {
    let state = initialSupervisorState();
    state = recordFailure(
      state,
      0,
      "binding /home/a/seat.sock: Address already in use"
    );
    state = recordFailure(
      state,
      1,
      "binding /home/a/seat.sock: Address already in use"
    );
    state = recordFailure(
      state,
      2,
      "binding /home/a/seat.sock: Address already in use"
    );
    const message = crashLoopMessage(state);
    expect(message).toContain("3 times");
    expect(message).toContain("120 seconds");
    // The child's own reason reaches the screen — which is only possible
    // because stdio is piped.
    expect(message).toContain("Address already in use");
  });
});

/** Epoch ms, as `claimRevival` requires. */
const T0 = 1_780_000_000_000;

describe("the revival budget", () => {
  it("allows MAX_REVIVALS in a window, spaced by the minimum interval", () => {
    let budget;
    let now = T0;
    for (let attempt = 0; attempt < MAX_REVIVALS; attempt += 1) {
      const claimed = claimRevival(budget, now);
      expect(claimed.allowed).toBe(true);
      budget = claimed.next;
      now += MIN_REVIVAL_INTERVAL_MS;
    }
    expect(claimRevival(budget, now).allowed).toBe(false);
  });

  it("refuses a second revival inside the minimum interval", () => {
    const first = claimRevival(undefined, T0);
    expect(first.allowed).toBe(true);
    expect(
      claimRevival(first.next, T0 + MIN_REVIVAL_INTERVAL_MS - 1).allowed
    ).toBe(false);
    expect(claimRevival(first.next, T0 + MIN_REVIVAL_INTERVAL_MS).allowed).toBe(
      true
    );
  });

  it("starts a fresh window once the old one expired", () => {
    let budget = claimRevival(undefined, T0).next;
    budget = claimRevival(budget, T0 + MIN_REVIVAL_INTERVAL_MS).next;
    budget = claimRevival(budget, T0 + MIN_REVIVAL_INTERVAL_MS * 2).next;
    expect(claimRevival(budget, T0 + MIN_REVIVAL_INTERVAL_MS * 3).allowed).toBe(
      false
    );
    const later = claimRevival(budget, T0 + REVIVAL_WINDOW_MS + 1);
    expect(later.allowed).toBe(true);
    expect(later.next.attempts).toBe(1);
  });

  /**
   * THE QUIRK, pinned. A fresh budget's `lastAttemptAt` is 0, so the interval
   * check is against the absolute clock: a caller that handed this a monotonic
   * uptime would have its first revival refused for the first fifteen seconds
   * of the process's life. v0 has the same arithmetic and it is carried
   * verbatim; this test exists so the requirement is a test and not a comment.
   */
  it("requires epoch milliseconds: a near-zero clock refuses the first revival", () => {
    expect(claimRevival(undefined, 0).allowed).toBe(false);
    expect(claimRevival(undefined, MIN_REVIVAL_INTERVAL_MS - 1).allowed).toBe(
      false
    );
    expect(claimRevival(undefined, MIN_REVIVAL_INTERVAL_MS).allowed).toBe(true);
  });
});

describe("manual retry", () => {
  it("absorbs a double click and then allows the next press", () => {
    const first = claimManualRetry(undefined, 1000);
    expect(first.allowed).toBe(true);
    expect(
      claimManualRetry(first.next, 1000 + MANUAL_RETRY_FLOOR_MS - 1).allowed
    ).toBe(false);
    expect(
      claimManualRetry(first.next, 1000 + MANUAL_RETRY_FLOOR_MS).allowed
    ).toBe(true);
  });
});

describe("revival, as the seat's narrow trigger", () => {
  const base = { owned: true, processGone: true, quitting: false, now: T0 };

  it("revives an owned seat whose process is really gone", () => {
    expect(mayRevive({ ...base, budget: undefined }).allowed).toBe(true);
  });

  it("never revives during teardown, and that check comes first", () => {
    const judged = mayRevive({ ...base, quitting: true, budget: undefined });
    expect(judged.allowed).toBe(false);
    expect(judged.why).toMatch(/quitting/u);
    // The budget is UNTOUCHED by a refusal during teardown, so a later real
    // revival is not charged for the shell shutting down.
    expect(judged.next).toBeUndefined();
  });

  it("never revives a seat that is still alive: a second one is a second writer", () => {
    const judged = mayRevive({
      ...base,
      processGone: false,
      budget: undefined,
    });
    expect(judged.allowed).toBe(false);
    expect(judged.why).toMatch(/second writer/u);
  });

  it("never revives a seat this shell does not own", () => {
    expect(mayRevive({ ...base, owned: false, budget: undefined }).why).toMatch(
      /does not own/u
    );
  });

  it("stops once the budget is spent, and says so", () => {
    let budget = claimRevival(undefined, T0).next;
    budget = claimRevival(budget, T0 + MIN_REVIVAL_INTERVAL_MS).next;
    budget = claimRevival(budget, T0 + MIN_REVIVAL_INTERVAL_MS * 2).next;
    const judged = mayRevive({
      ...base,
      now: T0 + MIN_REVIVAL_INTERVAL_MS * 3,
      budget,
    });
    expect(judged.allowed).toBe(false);
    expect(judged.why).toMatch(/budget/u);
  });
});

describe("what quit does", () => {
  it("disposes first, awaits the seat's close before signalling, and unlinks last", () => {
    const steps = quitSequence({ attached: true, processAlive: true }).map(
      (step) => step.step
    );
    expect(steps).toStrictEqual([
      "dispose",
      "terminate-command",
      "await-close",
      "sigterm",
      "wait",
      "sigkill",
      "await-exit",
      "unlink-socket",
    ]);
    // The two orderings that are load-bearing, asserted as orderings.
    expect(steps.indexOf("dispose")).toBeLessThan(
      steps.indexOf("terminate-command")
    );
    expect(steps.indexOf("await-close")).toBeLessThan(steps.indexOf("sigterm"));
    expect(steps.indexOf("await-exit")).toBeLessThan(
      steps.indexOf("unlink-socket")
    );
    const wait = quitSequence({ attached: true, processAlive: true }).find(
      (step) => step.step === "wait"
    );
    expect(wait).toStrictEqual({ step: "wait", ms: TERMINATE_GRACE_MS });
    expect(TERMINATE_GRACE_MS).toBe(5000);
  });

  it("skips the protocol close when nothing is attached", () => {
    expect(
      quitSequence({ attached: false, processAlive: true }).map(
        (step) => step.step
      )
    ).toStrictEqual([
      "dispose",
      "sigterm",
      "wait",
      "sigkill",
      "await-exit",
      "unlink-socket",
    ]);
  });

  it("still unlinks when the seat is already gone", () => {
    expect(
      quitSequence({ attached: false, processAlive: false }).map(
        (step) => step.step
      )
    ).toStrictEqual(["dispose", "unlink-socket"]);
  });
});

describe("classifying an exit", () => {
  it("separates a refusal, a usage error, a signal and a crash", () => {
    expect(
      classifyExit({
        code: 1,
        signal: null,
        stderrTail: "centraid: binding /x/seat.sock: Address already in use\n",
      })
    ).toStrictEqual({
      kind: "refused",
      detail: "centraid: binding /x/seat.sock: Address already in use",
    });
    expect(
      classifyExit({ code: 2, signal: null, stderrTail: "needs --socket" }).kind
    ).toBe("usage");
    expect(classifyExit({ code: 0, signal: null, stderrTail: "" }).kind).toBe(
      "clean"
    );
    expect(
      classifyExit({ code: null, signal: "SIGKILL", stderrTail: "" })
    ).toStrictEqual({
      kind: "signalled",
      detail: "the seat was killed by SIGKILL",
    });
    // An exit with nothing on stderr still says something, so the crash log is
    // never an empty entry.
    expect(
      classifyExit({ code: 139, signal: null, stderrTail: "" }).detail
    ).toContain("139");
  });

  it("keeps the last three stderr lines, which is where the reason is", () => {
    const detail = classifyExit({
      code: 1,
      signal: null,
      stderrTail: ["one", "two", "three", "four", "five"].join("\n"),
    }).detail;
    expect(detail).toBe("three four five");
    expect(detail).not.toContain("one");
  });
});
