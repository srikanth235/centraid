// Per-vault cap on running turns (#420); overflow gets 429 + Retry-After.

import type { ServerResponse } from "node:http";

export const DEFAULT_MAX_CONCURRENT_TURNS = 4;

export const TURN_RETRY_AFTER_SECONDS = 3;

export class TurnLimiter {
  private active = 0;

  constructor(private readonly max: number = DEFAULT_MAX_CONCURRENT_TURNS) {}

  count(): number {
    return this.active;
  }

  atCapacity(): boolean {
    return this.active >= this.max;
  }

  /** Release fn MUST be invoked exactly once at stream end. */
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

export function writeTurnBusy(res: ServerResponse): void {
  res.setHeader("Retry-After", String(TURN_RETRY_AFTER_SECONDS));
  const body = JSON.stringify({
    error: "turn_busy",
    message: `This vault is running too many turns at once — retrying shortly.`,
    retryAfterSeconds: TURN_RETRY_AFTER_SECONDS,
  });
  res.writeHead(429, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body).toString(),
  });
  res.end(body);
}
