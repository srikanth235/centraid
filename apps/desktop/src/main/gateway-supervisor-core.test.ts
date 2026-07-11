import { describe, expect, it } from 'vitest';
import {
  BACKOFF_SCHEDULE_MS,
  backoffForAttempt,
  CRASH_LOOP_THRESHOLD,
  CRASH_LOOP_WINDOW_MS,
  initialSupervisorState,
  recordFailure,
  recordSuccess,
} from './gateway-supervisor-core.js';

const T0 = 1_000_000;

describe('recordFailure', () => {
  it('records a single failure without tripping the loop breaker', () => {
    const state = recordFailure(initialSupervisorState(), T0, 'boom');
    expect(state.attempt).toBe(1);
    expect(state.loopBroken).toBe(false);
    expect(state.lastError).toBe('boom');
    expect(state.failures).toEqual([T0]);
  });

  it('trips loopBroken once failures reach the threshold inside the window', () => {
    let state = initialSupervisorState();
    for (let i = 0; i < CRASH_LOOP_THRESHOLD - 1; i++) {
      state = recordFailure(state, T0 + i * 1000, `fail-${i}`);
      expect(state.loopBroken).toBe(false);
    }
    state = recordFailure(state, T0 + (CRASH_LOOP_THRESHOLD - 1) * 1000, 'final');
    expect(state.loopBroken).toBe(true);
    expect(state.attempt).toBe(CRASH_LOOP_THRESHOLD);
    expect(state.lastError).toBe('final');
  });

  it('ages failures out of the window so a slow trickle never trips the breaker', () => {
    let state = initialSupervisorState();
    for (let i = 0; i < CRASH_LOOP_THRESHOLD + 5; i++) {
      state = recordFailure(state, T0 + i * (CRASH_LOOP_WINDOW_MS + 1000), `fail-${i}`);
      // Each failure lands long after the window elapsed for every prior one.
      expect(state.failures).toHaveLength(1);
      expect(state.loopBroken).toBe(false);
    }
  });

  it('keeps only in-window failures when a burst spans the window boundary', () => {
    let state = initialSupervisorState();
    state = recordFailure(state, T0, 'old-1');
    state = recordFailure(state, T0 + 1000, 'old-2');
    // Past the window relative to the first two — they should be pruned.
    state = recordFailure(state, T0 + CRASH_LOOP_WINDOW_MS + 2000, 'new-1');
    expect(state.failures).toEqual([T0 + CRASH_LOOP_WINDOW_MS + 2000]);
    expect(state.loopBroken).toBe(false);
  });
});

describe('recordSuccess', () => {
  it('resets to the initial state', () => {
    expect(recordSuccess()).toEqual(initialSupervisorState());
  });
});

describe('backoffForAttempt', () => {
  it('walks the schedule and clamps at the last entry', () => {
    expect(backoffForAttempt(1)).toBe(BACKOFF_SCHEDULE_MS[0]);
    expect(backoffForAttempt(2)).toBe(BACKOFF_SCHEDULE_MS[1]);
    expect(backoffForAttempt(3)).toBe(BACKOFF_SCHEDULE_MS[2]);
    expect(backoffForAttempt(10)).toBe(BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1]);
  });

  it('treats non-positive attempts as the first entry', () => {
    expect(backoffForAttempt(0)).toBe(BACKOFF_SCHEDULE_MS[0]);
    expect(backoffForAttempt(-3)).toBe(BACKOFF_SCHEDULE_MS[0]);
  });
});
