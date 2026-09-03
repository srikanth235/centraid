import { describe, expect, it } from "vitest";

import {
  BACKOFF_SCHEDULE_MS,
  backoffForAttempt,
  claimManualRetry,
  claimRevival,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  initialSupervisorState,
  MANUAL_RETRY_FLOOR_MS,
  MAX_REVIVALS,
  MIN_REVIVAL_INTERVAL_MS,
  recordFailure,
  recordSuccess,
  REVIVAL_WINDOW_MS,
} from "./gateway-supervisor-core.js";

const T0 = 1_000_000;

describe(recordFailure, () => {
  it("records a single failure without tripping the loop breaker", () => {
    const state = recordFailure(initialSupervisorState(), T0, "boom");
    expect(state.attempt).toBe(1);
    expect(state.loopBroken).toBe(false);
    expect(state.lastError).toBe("boom");
    expect(state.failures).toStrictEqual([T0]);
  });

  it("trips loopBroken once failures reach the threshold inside the window", () => {
    let state = initialSupervisorState();
    for (let i = 0; i < CRASH_LOOP_THRESHOLD - 1; i++) {
      state = recordFailure(state, T0 + i * 1000, `fail-${i}`);
      expect(state.loopBroken).toBe(false);
    }
    state = recordFailure(
      state,
      T0 + (CRASH_LOOP_THRESHOLD - 1) * 1000,
      "final"
    );
    expect(state.loopBroken).toBe(true);
    expect(state.attempt).toBe(CRASH_LOOP_THRESHOLD);
    expect(state.lastError).toBe("final");
  });

  it("ages failures out of the window so a slow trickle never trips the breaker", () => {
    let state = initialSupervisorState();
    for (let i = 0; i < CRASH_LOOP_THRESHOLD + 5; i++) {
      state = recordFailure(
        state,
        T0 + i * (CRASH_LOOP_WINDOW_MS + 1000),
        `fail-${i}`
      );
      expect(state.failures).toHaveLength(1);
      expect(state.loopBroken).toBe(false);
    }
  });

  it("keeps only in-window failures when a burst spans the window boundary", () => {
    let state = initialSupervisorState();
    state = recordFailure(state, T0, "old-1");
    state = recordFailure(state, T0 + 1000, "old-2");
    state = recordFailure(state, T0 + CRASH_LOOP_WINDOW_MS + 2000, "new-1");
    expect(state.failures).toStrictEqual([T0 + CRASH_LOOP_WINDOW_MS + 2000]);
    expect(state.loopBroken).toBe(false);
  });
});

describe(recordSuccess, () => {
  it("resets to the initial state", () => {
    expect(recordSuccess()).toStrictEqual(initialSupervisorState());
  });
});

describe(backoffForAttempt, () => {
  it("walks the schedule and clamps at the last entry", () => {
    expect(backoffForAttempt(1)).toBe(BACKOFF_SCHEDULE_MS[0]);
    expect(backoffForAttempt(2)).toBe(BACKOFF_SCHEDULE_MS[1]);
    expect(backoffForAttempt(3)).toBe(BACKOFF_SCHEDULE_MS[2]);
    expect(backoffForAttempt(10)).toBe(
      BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]
    );
  });

  it("treats non-positive attempts as the first entry", () => {
    expect(backoffForAttempt(0)).toBe(BACKOFF_SCHEDULE_MS[0]);
    expect(backoffForAttempt(-3)).toBe(BACKOFF_SCHEDULE_MS[0]);
  });
});

describe(claimRevival, () => {
  it("revives a first death immediately", () => {
    const claim = claimRevival(undefined, T0);
    expect(claim.allowed).toBe(true);
    expect(claim.next).toStrictEqual({
      windowStartedAt: T0,
      attempts: 1,
      lastAttemptAt: T0,
    });
  });

  it("refuses a second revival inside the minimum interval", () => {
    const first = claimRevival(undefined, T0);
    const tooSoon = claimRevival(first.next, T0 + MIN_REVIVAL_INTERVAL_MS - 1);
    expect(tooSoon.allowed).toBe(false);
    // A refusal must not consume a slot, or a chatty monitor would burn the
    // whole budget in one second of ticks.
    expect(tooSoon.next).toStrictEqual(first.next);
  });

  it("stops after MAX_REVIVALS inside the window", () => {
    let budget = claimRevival(undefined, T0).next;
    let at = T0;
    for (let i = 1; i < MAX_REVIVALS; i++) {
      at += MIN_REVIVAL_INTERVAL_MS;
      const claim = claimRevival(budget, at);
      expect(claim.allowed).toBe(true);
      budget = claim.next;
    }
    expect(budget.attempts).toBe(MAX_REVIVALS);
    at += MIN_REVIVAL_INTERVAL_MS;
    expect(claimRevival(budget, at).allowed).toBe(false);
  });

  it("reopens the budget once the window has fully elapsed", () => {
    let budget = claimRevival(undefined, T0).next;
    let at = T0;
    for (let i = 1; i < MAX_REVIVALS; i++) {
      at += MIN_REVIVAL_INTERVAL_MS;
      budget = claimRevival(budget, at).next;
    }
    expect(claimRevival(budget, T0 + REVIVAL_WINDOW_MS).allowed).toBe(false);
    const later = claimRevival(budget, T0 + REVIVAL_WINDOW_MS + 1);
    expect(later.allowed).toBe(true);
    expect(later.next.attempts).toBe(1);
  });
});

describe(claimManualRetry, () => {
  it("allows the first user-initiated retry", () => {
    const claim = claimManualRetry(undefined, T0);
    expect(claim.allowed).toBe(true);
    expect(claim.next).toBe(T0);
  });

  it("collapses a second press inside the floor", () => {
    const first = claimManualRetry(undefined, T0);
    const tooSoon = claimManualRetry(
      first.next,
      T0 + MANUAL_RETRY_FLOOR_MS - 1
    );
    expect(tooSoon.allowed).toBe(false);
    // A refusal must not slide the floor forward, or holding the button down
    // would keep pushing the next real attempt out of reach.
    expect(tooSoon.next).toBe(T0);
  });

  it("allows another attempt once the floor has elapsed", () => {
    const first = claimManualRetry(undefined, T0);
    const later = claimManualRetry(first.next, T0 + MANUAL_RETRY_FLOOR_MS);
    expect(later.allowed).toBe(true);
    expect(later.next).toBe(T0 + MANUAL_RETRY_FLOOR_MS);
  });

  // The floor is the ONLY bound on an explicit retry: unlike the revival
  // budget there is no exhaustion, because a person who has just fixed the
  // cause must never be told they are out of tries.
  it("never runs out of tries", () => {
    let at = T0;
    let last: number | undefined;
    for (let i = 0; i < 50; i++) {
      at += MANUAL_RETRY_FLOOR_MS;
      const claim = claimManualRetry(last, at);
      expect(claim.allowed).toBe(true);
      last = claim.next;
    }
  });
});
