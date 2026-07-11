/*
 * Concurrency admission for app-handler worker spawns (issue #351 Tier 4
 * hygiene). `runHandler` (`handler-runner.ts`) used to spawn one
 * 256MB-capped worker thread per request with no cap at all — a request
 * burst could spawn unboundedly and OOM the host process. This gates
 * worker creation: at most `maxConcurrent` workers running, a short FIFO
 * queue for the rest bounded by both length and wait time — beyond that
 * the caller gets a fast "gateway busy" failure instead of a request that
 * either hangs or piles on more workers.
 */

/** Concurrent app-handler workers allowed at once. */
export const WORKER_MAX_CONCURRENT = 8;
/** Requests allowed to wait for a free slot before admission refuses. */
export const WORKER_MAX_QUEUE = 16;
/** Longest a queued request waits for a slot before it gives up. */
export const WORKER_MAX_QUEUE_WAIT_MS = 10_000;

/**
 * The gateway is at capacity — `runHandler` turns this into a `busy`
 * outcome, never a throw the caller has to catch. A factory (not a
 * subclass) so this file stays to one class (`WorkerAdmission`); callers
 * read `.message`, and the stamped `name` gives it identity in logs —
 * mirrors `authDeadError` in the gateway's `connection-limiter.ts`.
 */
export function gatewayBusyError(
  message = 'gateway busy: too many concurrent app handlers, try again shortly',
): Error {
  const err = new Error(message);
  err.name = 'GatewayBusyError';
  return err;
}

interface QueueEntry {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

/**
 * A FIFO admission gate over a fixed number of concurrent slots. One
 * instance guards every real worker spawn (the module-level
 * `sharedWorkerAdmission` below, wired into `runHandler`'s default);
 * tests construct their own small instance to exercise the cap without
 * spinning up dozens of real worker threads.
 */
export class WorkerAdmission {
  private inFlight = 0;
  private readonly queue: QueueEntry[] = [];

  constructor(
    private readonly maxConcurrent: number = WORKER_MAX_CONCURRENT,
    private readonly maxQueue: number = WORKER_MAX_QUEUE,
    private readonly maxQueueWaitMs: number = WORKER_MAX_QUEUE_WAIT_MS,
  ) {}

  /** Live counts — small accessor for a health/metrics surface to poll. */
  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.inFlight, queued: this.queue.length };
  }

  /**
   * Resolve once a slot is free. Rejects with `GatewayBusyError` immediately
   * when both the concurrent slots AND the wait queue are full, or after
   * `maxQueueWaitMs` waiting in queue — either way the caller fails fast
   * rather than spawning a worker into an already-saturated host.
   */
  async acquire(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return;
    }
    if (this.queue.length >= this.maxQueue) {
      throw gatewayBusyError();
    }
    await new Promise<void>((resolve, reject) => {
      const entry: QueueEntry = {
        resolve: () => {
          clearTimeout(entry.timer);
          this.inFlight += 1;
          resolve();
        },
        timer: setTimeout(() => {
          const idx = this.queue.indexOf(entry);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(gatewayBusyError('gateway busy: timed out waiting for a free worker slot'));
        }, this.maxQueueWaitMs),
      };
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  /** Free a slot and hand it to the next queued waiter (FIFO), if any. */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const next = this.queue.shift();
    next?.resolve();
  }
}

/** The one admission gate guarding every real worker spawn (`handler-runner.ts`'s default). */
export const sharedWorkerAdmission = new WorkerAdmission();

/** Live counts on the shared production admission gate (issue #351). */
export function workerAdmissionStats(): { inFlight: number; queued: number } {
  return sharedWorkerAdmission.stats();
}
