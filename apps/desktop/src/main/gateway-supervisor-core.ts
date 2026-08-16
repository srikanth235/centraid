/*
 * Pure backoff + crash-loop bookkeeping for the embedded local gateway
 * (issue #351). Extracted from local-gateway.ts so it's unit-testable
 * without pulling in `@centraid/server`'s `serve()`.
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
  const idx = Math.min(
    Math.max(attempt, 1) - 1,
    BACKOFF_SCHEDULE_MS.length - 1
  );
  return BACKOFF_SCHEDULE_MS[idx] as number;
}

/** Fold one failure into the supervisor state. Pure — returns a new state. */
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

/** A successful start clears all supervision bookkeeping. */
export function recordSuccess(): SupervisorState {
  return initialSupervisorState();
}

/*
 * Revival budget — the bookkeeping above covers gateways that fail to START.
 * A detached daemon that started fine and DIED later needs its own bound,
 * because the trigger is the 5s monitor heartbeat: with no budget, a daemon
 * that dies on every launch would be respawned twelve times a minute forever.
 */

/** Revivals allowed inside {@link REVIVAL_WINDOW_MS}. */
export const MAX_REVIVALS = 3;
/** Sliding window the revival count is measured against. */
export const REVIVAL_WINDOW_MS = 10 * 60_000;
/** Floor between two revival attempts, so one death can't fan out per tick. */
export const MIN_REVIVAL_INTERVAL_MS = 15_000;

export interface RevivalBudget {
  windowStartedAt: number;
  attempts: number;
  lastAttemptAt: number;
}

/**
 * Decide whether a dead owned daemon may be respawned now, and return the
 * budget to store either way. Pure. `prev` is `undefined` the first time.
 * The window resets once it has fully elapsed, so an isolated death long after
 * an exhausted burst is always revived.
 */
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

/*
 * Explicit, user-initiated retry.
 *
 * Both budgets above are give-up-shaped on purpose: they exist so a gateway
 * that cannot start stops being hammered. But they bound AUTOMATIC attempts.
 * When a person presses "Try again" they are asserting new information — they
 * just killed the process holding the lock, or put the credential file back —
 * and refusing them because an automatic budget is exhausted strands them on a
 * screen whose only other exit is quitting the app. That is exactly how the
 * startup error screen's one button came to be dead: the supervisor had
 * latched `loopBroken`, so every re-read failed instantly with the same
 * message no matter what the user had fixed.
 *
 * So an explicit retry clears the give-up state. What it must NOT become is an
 * unbounded respawn loop for a daemon that crashes on every launch, driven by
 * a human leaning on the button — so one floor survives: two presses closer
 * together than {@link MANUAL_RETRY_FLOOR_MS} collapse into a single attempt,
 * and the second caller gets the first one's outcome. The floor is short
 * because a person pressing a button is not a loop: it only has to absorb
 * double-clicks and a held-down Enter key, and a real start attempt against a
 * broken gateway already takes longer than that on its own. Beyond the floor
 * every press costs exactly one start attempt — bounded by how fast a human
 * can click, which is the bound we actually want here.
 */

/** Minimum gap between two user-initiated retries of the same gateway. */
export const MANUAL_RETRY_FLOOR_MS = 3000;

/**
 * Decide whether a user-initiated retry may start a new attempt now, and
 * return the timestamp to store either way. Pure. `lastAttemptAt` is
 * `undefined` the first time.
 */
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
