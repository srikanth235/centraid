/* Pure backoff + crash-loop bookkeeping; no `serve()` import. */

export interface SupervisorState {
  /** Epoch ms, within the window. */
  failures: number[];
  attempt: number;
  loopBroken: boolean;
  lastError?: string;
}

export const BACKOFF_SCHEDULE_MS = [1000, 5000, 30_000] as const;
export const CRASH_LOOP_WINDOW_MS = 2 * 60 * 1000;
export const CRASH_LOOP_THRESHOLD = 3;

export function initialSupervisorState(): SupervisorState {
  return { failures: [], attempt: 0, loopBroken: false };
}

/** 1-based — pass `state.attempt` after a failure. */
export function backoffForAttempt(attempt: number): number {
  const idx = Math.min(
    Math.max(attempt, 1) - 1,
    BACKOFF_SCHEDULE_MS.length - 1
  );
  return BACKOFF_SCHEDULE_MS[idx] as number;
}

export function recordFailure(
  state: SupervisorState,
  now: number,
  message: string
): SupervisorState {
  const failures = [...state.failures, now].filter(
    (t) => now - t <= CRASH_LOOP_WINDOW_MS
  );
  return {
    failures,
    attempt: state.attempt + 1,
    loopBroken: failures.length >= CRASH_LOOP_THRESHOLD,
    lastError: message,
  };
}

export function recordSuccess(): SupervisorState {
  return initialSupervisorState();
}

/* Bounds a daemon that died after starting; the heartbeat would respawn forever. */

export const MAX_REVIVALS = 3;
export const REVIVAL_WINDOW_MS = 10 * 60_000;
export const MIN_REVIVAL_INTERVAL_MS = 15_000;

export interface RevivalBudget {
  windowStartedAt: number;
  attempts: number;
  lastAttemptAt: number;
}

export function claimRevival(
  prev: RevivalBudget | undefined,
  now: number
): { allowed: boolean; next: RevivalBudget } {
  const expired =
    prev === undefined || now - prev.windowStartedAt > REVIVAL_WINDOW_MS;
  const budget: RevivalBudget = expired
    ? { windowStartedAt: now, attempts: 0, lastAttemptAt: 0 }
    : prev;
  const allowed =
    budget.attempts < MAX_REVIVALS &&
    now - budget.lastAttemptAt >= MIN_REVIVAL_INTERVAL_MS;
  if (!allowed) return { allowed, next: budget };
  return {
    allowed,
    next: {
      windowStartedAt: budget.windowStartedAt,
      attempts: budget.attempts + 1,
      lastAttemptAt: now,
    },
  };
}

/* Explicit retry clears both give-up budgets; this floor absorbs double-clicks. */
export const MANUAL_RETRY_FLOOR_MS = 3000;

export function claimManualRetry(
  lastAttemptAt: number | undefined,
  now: number
): { allowed: boolean; next: number } {
  if (
    lastAttemptAt !== undefined &&
    now - lastAttemptAt < MANUAL_RETRY_FLOOR_MS
  ) {
    return { allowed: false, next: lastAttemptAt };
  }
  return { allowed: true, next: now };
}
