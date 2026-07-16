// Reconnect catch-up from the ledger (issue #420, Wave 6). When an assistant
// turn's SSE stream dies mid-turn (connection drop, no terminal `event: end`),
// the backend still finishes the turn and folds its events into the ledger. The
// client can't resume the raw stream, but it CAN poll the cheap turn-settle
// endpoint until the turn lands, then reload the transcript to materialize the
// completed answer. This module is that poll loop — pure timing over the
// injected `getStatus`, so it unit-tests without a live gateway.

/** One turn-settle poll result. */
export interface CatchUpStatus {
  turnCount: number;
  updatedAt: number;
}

export interface CatchUpOptions {
  /** Turn count observed BEFORE the dropped send — the turn settled once it climbs. */
  baselineTurnCount: number;
  /** Poll for the settle status (typically `conversationStatus(appId, id)`). */
  getStatus: () => Promise<CatchUpStatus>;
  /** Abort the loop early (thread teardown / user navigated away). */
  isCancelled?: () => boolean;
  /** Overall budget before giving up and surfacing the resend affordance. */
  timeoutMs?: number;
  /** Gap between polls. */
  intervalMs?: number;
  /** Sleep injection point (tests pass an instant resolver). */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_INTERVAL_MS = 1_500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until the conversation's `turnCount` climbs past `baselineTurnCount`
 * (the turn recorded server-side) or the timeout elapses. Resolves `true` when
 * the turn settled — the caller should then reload the transcript — or `false`
 * on timeout/cancel, where the caller shows the one-tap resend instead.
 */
export async function catchUpAfterDrop(opts: CatchUpOptions): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + timeoutMs;
  const target = opts.baselineTurnCount + 1;
  for (;;) {
    if (opts.isCancelled?.()) return false;
    try {
      const status = await opts.getStatus();
      if (status.turnCount >= target) return true;
    } catch {
      /* transient — keep polling until the deadline */
    }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}
