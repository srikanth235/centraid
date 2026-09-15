/*
 * Pure backoff, crash-loop and revival bookkeeping for the seat sidecar
 * (#1020, D-1020-F1). No `child_process`, no `electron`.
 *
 * **The arithmetic is v0's, carried verbatim** from
 * `apps/desktop/src/main/gateway-supervisor-core.ts`: the backoff schedule, the
 * crash-loop window and threshold, the revival budget and the manual-retry
 * floor. Those numbers were tuned against a shipped product and nothing about a
 * seat process makes them wrong, so they are copied rather than re-derived —
 * and the v0 unit suite's cases are carried with them.
 *
 * What is NEW here is [`quitSequence`], because the product decision changed:
 * v0's quit deliberately leaves a detached gateway running (census §F seam 1,
 * `local-gateway.ts:336`–`:348`), and a seat process whose only client is this
 * window is OWNED — quit stops it. The sequence below is the ordering that
 * makes that safe, and its steps are asserted rather than described.
 */

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

/**
 * The sentence the startup error screen shows, verbatim.
 *
 * Quoted on screen and not summarised: an operator reading "it keeps crashing"
 * learns nothing, and the count and the window are what tell them whether to
 * wait or to act.
 */
export function crashLoopMessage(state: SupervisorState): string {
  const window = Math.round(CRASH_LOOP_WINDOW_MS / 1000);
  const detail = state.lastError ? ` Last error: ${state.lastError}` : "";
  return (
    `The Centraid seat process failed ${state.failures.length} times in ${window} seconds, ` +
    `so it will not be restarted automatically.${detail}`
  );
}

export function initialSupervisorState(): SupervisorState {
  return { failures: [], attempt: 0, loopBroken: false };
}

/** 1-based — pass `state.attempt` after a failure. */
export function backoffForAttempt(attempt: number): number {
  const index = Math.min(
    Math.max(attempt, 1) - 1,
    BACKOFF_SCHEDULE_MS.length - 1
  );
  return BACKOFF_SCHEDULE_MS[index] as number;
}

export function recordFailure(
  state: SupervisorState,
  now: number,
  message: string
): SupervisorState {
  const failures = [...state.failures, now].filter(
    (at) => now - at <= CRASH_LOOP_WINDOW_MS
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

/* Bounds a sidecar that died after starting; the heartbeat would respawn forever. */

export const MAX_REVIVALS = 3;
export const REVIVAL_WINDOW_MS = 10 * 60_000;
export const MIN_REVIVAL_INTERVAL_MS = 15_000;

export interface RevivalBudget {
  windowStartedAt: number;
  attempts: number;
  lastAttemptAt: number;
}

/**
 * `now` is **epoch milliseconds**, and that is load-bearing.
 *
 * A fresh budget starts with `lastAttemptAt: 0`, so the interval check reads
 * `now - 0 >= MIN_REVIVAL_INTERVAL_MS` — which a monotonic clock starting near
 * zero would fail, refusing the very first revival. v0 has the same arithmetic
 * and the same requirement; it is carried verbatim (D-1020-F1) and named here
 * rather than "fixed", because changing the comparison would change when the
 * second and third revivals are allowed too. The test below pins the quirk so
 * a future caller cannot hand this an uptime counter by accident.
 */
export function claimRevival(
  previous: RevivalBudget | undefined,
  now: number
): { allowed: boolean; next: RevivalBudget } {
  const expired =
    previous === undefined ||
    now - previous.windowStartedAt > REVIVAL_WINDOW_MS;
  const budget: RevivalBudget = expired
    ? { windowStartedAt: now, attempts: 0, lastAttemptAt: 0 }
    : previous;
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

/**
 * Whether a sidecar that died after a clean start may be revived.
 *
 * v0's trigger is deliberately narrow — detached AND owned AND the pid really
 * gone — because "a wedged daemon still holds gateway.db"
 * (`local-gateway.ts:286`–`:326`). For a seat the second clause is always true
 * (the shell owns the process it spawned) and the third still matters for the
 * same reason: a wedged seat still holds the vault file's write lock, and
 * spawning a second one over it is how two writers happen.
 */
export function mayRevive(input: {
  owned: boolean;
  processGone: boolean;
  quitting: boolean;
  budget: RevivalBudget | undefined;
  now: number;
}): { allowed: boolean; next: RevivalBudget | undefined; why?: string } {
  // FIRST, always: a mid-teardown revival would resurrect a closing seat. The
  // ordering bug v0 names at `main.ts:180`–`:182`.
  if (input.quitting) {
    return { allowed: false, next: input.budget, why: "the shell is quitting" };
  }
  if (!input.owned) {
    return {
      allowed: false,
      next: input.budget,
      why: "this shell does not own that seat",
    };
  }
  if (!input.processGone) {
    return {
      allowed: false,
      next: input.budget,
      why: "the seat process is still alive, and a second one would be a second writer",
    };
  }
  const claimed = claimRevival(input.budget, input.now);
  return claimed.allowed
    ? { allowed: true, next: claimed.next }
    : {
        allowed: false,
        next: claimed.next,
        why: "the revival budget is spent",
      };
}

/** One step of the quit sequence, in order. */
export type QuitStep =
  | { step: "dispose" }
  | { step: "terminate-command" }
  | { step: "await-close" }
  | { step: "sigterm" }
  | { step: "wait"; ms: number }
  | { step: "sigkill" }
  | { step: "await-exit" }
  | { step: "unlink-socket" };

/** How long teardown gets before the signal escalates. v0's `terminateDetachedGateway`. */
export const TERMINATE_GRACE_MS = 5000;

/**
 * What quit does, as a list (#1020, D-1020-F1).
 *
 * The order is the whole content, and each step is here because leaving it out
 * is a shipped bug in v0's own notes:
 *
 * 1. `dispose` — mark the supervisor disposed FIRST, so a mid-teardown auto
 *    retry cannot resurrect a closing seat (`main.ts:180`–`:182`).
 * 2. `terminate-command` — the protocol's own terminal command, so the seat
 *    closes the core deliberately.
 * 3. `await-close` — wait for the seat's `closing`. This is where the vault's
 *    last write lands; signalling first is the process-death case lane D2
 *    tested, on purpose instead of by accident.
 * 4. `sigterm`, 5. `wait`, 6. `sigkill` — v0's escalation, unchanged.
 * 7. `await-exit` — **awaited** before anything reuses the socket path
 *    (census §F seam 2: `terminateDetachedGateway` must be awaited before a
 *    port rebind or a stamp re-read).
 * 8. `unlink-socket` — last, because unlinking a socket a live process still
 *    holds leaves the next launch probing a path nobody answers.
 */
export function quitSequence(input: {
  attached: boolean;
  processAlive: boolean;
}): QuitStep[] {
  const steps: QuitStep[] = [{ step: "dispose" }];
  if (input.attached) {
    steps.push({ step: "terminate-command" }, { step: "await-close" });
  }
  if (input.processAlive) {
    steps.push(
      { step: "sigterm" },
      { step: "wait", ms: TERMINATE_GRACE_MS },
      { step: "sigkill" },
      { step: "await-exit" }
    );
  }
  steps.push({ step: "unlink-socket" });
  return steps;
}

/**
 * Classify a sidecar exit for the crash log.
 *
 * The reason a seat died is only knowable because `stdio` is **piped and
 * logged, never `ignore`** (census §F seam 3): under `ignore` an `EADDRINUSE`
 * exit is invisible and surfaces thirty seconds later as a ready-poll timeout
 * against a stranger's process. For a seat the same bug wears a socket path
 * instead of a port, so the classification reads the child's own stderr.
 */
export function classifyExit(input: {
  code: number | null;
  signal: string | null;
  stderrTail: string;
}): {
  kind: "clean" | "refused" | "usage" | "signalled" | "crashed";
  detail: string;
} {
  if (input.signal) {
    return {
      kind: "signalled",
      detail: `the seat was killed by ${input.signal}`,
    };
  }
  const tail = input.stderrTail.trim().split("\n").slice(-3).join(" ").trim();
  switch (input.code) {
    case 0:
      return { kind: "clean", detail: "the seat exited normally" };
    case 1:
      return { kind: "refused", detail: tail || "the seat refused to start" };
    case 2:
      return {
        kind: "usage",
        detail: tail || "the seat was started with wrong arguments",
      };
    default:
      return {
        kind: "crashed",
        detail:
          tail ||
          `the seat exited ${String(input.code)} with nothing on stderr`,
      };
  }
}
