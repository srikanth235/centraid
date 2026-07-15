import { retryTerminalReplicaPurges, type ReplicaStoragePurgeOptions } from './storage-manifest.js';

const DEFAULT_RETRY_DELAY_MS = 5_000;

/**
 * Browser-lifetime driver for the durable terminal-pending inventory. A fresh
 * instance starts with an immediate sweep, so pending cleanup survives reload.
 */
export class TerminalReplicaPurgeRetryLoop {
  readonly #options: ReplicaStoragePurgeOptions;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #started = false;
  #wakeRequested = false;

  constructor(options: ReplicaStoragePurgeOptions = {}) {
    this.#options = options;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.schedule(0);
  }

  /** Re-check immediately after a lifecycle event adds terminal work. */
  wake(): void {
    if (!this.#started) return;
    if (this.#running) {
      this.#wakeRequested = true;
      return;
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.schedule(0);
  }

  stop(): void {
    this.#started = false;
    this.#wakeRequested = false;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  private schedule(delayMs: number): void {
    if (!this.#started || this.#timer) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        void this.run();
      },
      Math.max(0, delayMs),
    );
  }

  private async run(): Promise<void> {
    if (!this.#started || this.#running) return;
    this.#running = true;
    let nextRetryAt: number | undefined;
    try {
      nextRetryAt = await retryTerminalReplicaPurges(this.#options);
    } catch {
      nextRetryAt = this.now() + this.retryFloor();
    } finally {
      this.#running = false;
    }
    if (!this.#started) return;
    if (this.#wakeRequested) {
      this.#wakeRequested = false;
      this.schedule(0);
      return;
    }
    if (nextRetryAt === undefined) return;
    const remaining = nextRetryAt - this.now();
    this.schedule(remaining > 0 ? remaining : this.retryFloor());
  }

  private now(): number {
    return (this.#options.now ?? Date.now)();
  }

  private retryFloor(): number {
    const configured = this.#options.retryBaseDelayMs;
    return typeof configured === 'number' && Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_RETRY_DELAY_MS;
  }
}
