export function authDeadError(message: string): Error {
  const err = new Error(message);
  err.name = "AuthDeadError";
  return err;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ConnectionLimiter {
  private inFlight = 0;
  private lastStart = 0;
  private readonly queue: Array<() => void> = [];
  constructor(
    private readonly maxConcurrent = 2,
    private readonly minIntervalMs = 250
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
      await new Promise<void>((resolve) => {
        this.queue.push(resolve);
      });
    }
    this.inFlight += 1;
    const wait = this.lastStart + this.minIntervalMs - Date.now();
    if (wait > 0) await delay(wait);
    this.lastStart = Date.now();
  }
}
