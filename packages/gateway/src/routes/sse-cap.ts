/*
 * Shared per-surface SSE concurrent-subscriber cap (issue #351 Tier 4
 * hygiene). Every SSE surface the gateway serves (`/centraid/_logs/events`,
 * `/centraid/_automations/run/events`) accepted unlimited clients — a
 * buggy client reconnect loop could pile up live connections until the
 * process ran out of file descriptors. Each surface gets its own
 * `SseSubscriberCap`; once it is saturated a new subscribe request gets a
 * `503` + `Retry-After` instead of joining the stream.
 */

import type { ServerResponse } from 'node:http';
import { sendJson } from './route-helpers.js';

/** Concurrent subscribers a single SSE surface accepts. These are personal
 * gateways with a handful of devices, not a public streaming service. */
export const SSE_MAX_SUBSCRIBERS = 32;

/** Seconds a refused client should wait before retrying (`Retry-After`). */
const SSE_RETRY_AFTER_SECONDS = 5;

export class SseSubscriberCap {
  private count = 0;

  constructor(private readonly max: number = SSE_MAX_SUBSCRIBERS) {}

  /** Live subscriber count — small accessor for a health/metrics surface to poll. */
  current(): number {
    return this.count;
  }

  /**
   * Try to admit one subscriber. On success increments the live count and
   * returns a release function the caller MUST invoke exactly once when the
   * stream ends (close/error). On saturation writes a `503` JSON error with
   * `Retry-After` onto `res` and returns `undefined` — the caller must not
   * write a stream response afterward.
   */
  admit(res: ServerResponse): (() => void) | undefined {
    if (this.count >= this.max) {
      res.setHeader('Retry-After', String(SSE_RETRY_AFTER_SECONDS));
      sendJson(res, 503, {
        error: 'sse_capacity',
        message: `too many concurrent subscribers on this stream (max ${this.max}) — retry shortly`,
      });
      return undefined;
    }
    this.count += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.count = Math.max(0, this.count - 1);
    };
  }
}
