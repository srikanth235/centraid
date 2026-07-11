/*
 * Pure backoff + crash-loop bookkeeping for the embedded local gateway
 * (issue #351). Extracted from local-gateway.ts so it's unit-testable
 * without pulling in `@centraid/gateway`'s `serve()`.
 *
 * Before this module, every failed `serve()` call during lazy startup
 * (settings read, gateway switch, …) was retried immediately and
 * unconditionally on the very next call — a boot failure surfaced as
 * silent retry-storming with no user-visible signal. The model here:
 *
 *   - each failure is recorded with a timestamp; failures older than
 *     {@link CRASH_LOOP_WINDOW_MS} age out of the window
 *   - {@link CRASH_LOOP_THRESHOLD} failures inside the window trips
 *     `loopBroken` — the caller (local-gateway.ts) stops attempting
 *     restarts until an explicit manual restart clears it
 *   - short of that, each failure schedules exactly one retry after an
 *     increasing backoff delay ({@link BACKOFF_SCHEDULE_MS}), so callers
 *     that ask "is the gateway up" during the backoff window get a fast,
 *     clear rejection instead of triggering another redundant attempt
 */

export interface SupervisorState {
  /** Epoch-ms timestamps of failures still inside the crash-loop window. */
  failures: number[];
  /** Total consecutive failures since the last success (drives backoff). */
  attempt: number;
  /** Once true, supervision stops retrying until explicitly reset. */
  loopBroken: boolean;
  /** Message from the most recent failure, surfaced in the runtime snapshot. */
  lastError?: string;
}

/** Retry delays, in order, for the 1st/2nd/3rd+ consecutive failure. */
export const BACKOFF_SCHEDULE_MS = [1000, 5000, 30_000] as const;
/** Sliding window a burst of failures is measured against. */
export const CRASH_LOOP_WINDOW_MS = 2 * 60 * 1000;
/** Failures inside the window before supervision gives up and alerts. */
export const CRASH_LOOP_THRESHOLD = 3;

export function initialSupervisorState(): SupervisorState {
  return { failures: [], attempt: 0, loopBroken: false };
}

/**
 * Backoff delay for the Nth consecutive failure (1-based — call with
 * `state.attempt` right after `recordFailure`). Clamps to the last
 * scheduled delay once `attempt` exceeds the schedule length.
 */
export function backoffForAttempt(attempt: number): number {
  const idx = Math.min(Math.max(attempt, 1) - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx] as number;
}

/** Fold one failure into the supervisor state. Pure — returns a new state. */
export function recordFailure(
  state: SupervisorState,
  now: number,
  message: string,
): SupervisorState {
  const failures = [...state.failures, now].filter((t) => now - t <= CRASH_LOOP_WINDOW_MS);
  return {
    failures,
    attempt: state.attempt + 1,
    loopBroken: failures.length >= CRASH_LOOP_THRESHOLD,
    lastError: message,
  };
}

/** A successful start clears all supervision bookkeeping. */
export function recordSuccess(): SupervisorState {
  return initialSupervisorState();
}
