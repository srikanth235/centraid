/*
 * Per-connection rate gate + the auth-dead marker error, split out of
 * `connection-broker.ts` (issue #304). Kept as a sibling so the broker file
 * stays a single class (the `ConnectionBroker` connection lifecycle); these
 * helpers are self-contained and carry no broker dependency.
 */

/**
 * The credential is dead upstream — needs a new consent ceremony. A factory
 * (not a subclass) because it is never caught via `instanceof`; callers read
 * `.message`, and the stamped `name` gives it identity in logs. Keeping it a
 * plain `Error` also holds this file to one class.
 */
export function authDeadError(message: string): Error {
  const err = new Error(message);
  err.name = 'AuthDeadError';
  return err;
}

/** Resolve after `ms` — the shared transient-retry / rate-gate sleep. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tiny per-connection rate gate: at most `maxConcurrent` injected requests
 * in flight and `minIntervalMs` between request STARTS, shared across every
 * fire on the connection — several automations on one Google connection
 * queue here instead of stampeding one quota (issue #304 decision 5).
 */
export class ConnectionLimiter {
  private inFlight = 0;
  private lastStart = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly maxConcurrent = 2,
    private readonly minIntervalMs = 250,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      this.queue.shift()?.();
    }
  }

  private async acquire(): Promise<void> {
    if (this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight += 1;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await delay(wait);
    this.lastStart = Date.now();
  }
}
