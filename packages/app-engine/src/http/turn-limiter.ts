/*
 * In-process turn concurrency limiter (issue #420, Wave 6). Beyond the
 * per-conversation lock (`withConversationLock`), which only serializes turns
 * on ONE conversation, nothing bounded how many model turns a vault could run
 * at once — N tabs / devices firing distinct conversations would each spawn an
 * adapter subprocess. This is a modest per-vault gate: at most `max` running
 * turns; a turn past the ceiling gets a `429` + `Retry-After` and the client
 * auto-retries. Mirrors the `SseSubscriberCap` shape (issue #351).
 *
 * "Running" spans the whole SSE drive (lock wait + model run), released when
 * the stream ends. The Wave-3 auto-title one-shot checks `atCapacity()` and
 * yields, so titling never steals a slot from an interactive turn.
 */

import type { ServerResponse } from 'node:http';

/** Concurrent running turns a single vault accepts. Personal gateway, a handful
 * of devices — not a public API. */
export const DEFAULT_MAX_CONCURRENT_TURNS = 4;

/** Seconds a throttled client waits before retrying (`Retry-After`). */
export const TURN_RETRY_AFTER_SECONDS = 3;

export class TurnLimiter {
  private active = 0;

  constructor(private readonly max: number = DEFAULT_MAX_CONCURRENT_TURNS) {}

  /** Live running-turn count. */
  count(): number {
    return this.active;
  }

  /** True when a new turn would exceed the ceiling (the titler's yield check). */
  atCapacity(): boolean {
    return this.active >= this.max;
  }

  /**
   * Try to admit one turn. On success returns a release fn the caller MUST
   * invoke exactly once when the turn's stream ends; on saturation returns
   * undefined (the caller writes a 429 and does not stream).
   */
  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.max) return undefined;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
    };
  }
}

/**
 * Write the standard turn-throttled `429` + `Retry-After` JSON response. Called
 * before any SSE headers, so the body is a plain JSON error the client's
 * transport reads to schedule its bounded auto-retry.
 */
export function writeTurnBusy(res: ServerResponse): void {
  res.setHeader('Retry-After', String(TURN_RETRY_AFTER_SECONDS));
  const body = JSON.stringify({
    error: 'turn_busy',
    message: `This vault is running too many turns at once — retrying shortly.`,
    retryAfterSeconds: TURN_RETRY_AFTER_SECONDS,
  });
  res.writeHead(429, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body).toString(),
  });
  res.end(body);
}
