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

import { availableParallelism, totalmem } from 'node:os';

export interface WorkerHostCapacity {
  cores: number;
  totalMemoryBytes: number;
}

function currentHostCapacity(): WorkerHostCapacity {
  return { cores: availableParallelism(), totalMemoryBytes: totalmem() };
}

export function isConstrainedWorkerHost(host: WorkerHostCapacity = currentHostCapacity()): boolean {
  return host.cores <= 4 || host.totalMemoryBytes <= 4 * 1024 ** 3;
}

/** Resolve the app-handler ceiling; explicit env always wins over host classification. */
export function workerMaxConcurrentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  host: WorkerHostCapacity = currentHostCapacity(),
): number {
  const resolvedProfile = env.CENTRAID_HARDWARE_PROFILE ?? env.CENTRAID_RESOLVED_HARDWARE_PROFILE;
  const constrained =
    resolvedProfile === 'constrained' ||
    (resolvedProfile !== 'standard' && isConstrainedWorkerHost(host));
  const fallback = constrained ? 2 : 8;
  const raw = env.CENTRAID_WORKER_MAX_CONCURRENT;
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 32) : fallback;
}

/** Concurrent app-handler workers allowed at once. */
export const WORKER_MAX_CONCURRENT = workerMaxConcurrentFromEnv();
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
  /** Cumulative admitted-task count since process start (#528 resource actuals). */
  private totalAcquired = 0;
  /** Cumulative wall-clock (ms) occupied by completed tasks (acquire→release). */
  private totalBusyMs = 0;
  /**
   * FIFO acquire timestamps awaiting a matching release. Total busyMs over a
   * bijection of acquires↔releases is pairing-independent, so oldest-first is
   * an exact running sum of completed per-task durations.
   */
  private readonly acquiredAt: number[] = [];

  constructor(
    private readonly maxConcurrent: number = WORKER_MAX_CONCURRENT,
    private readonly maxQueue: number = WORKER_MAX_QUEUE,
    private readonly maxQueueWaitMs: number = WORKER_MAX_QUEUE_WAIT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Live counts + cumulative resource actuals for a health/metrics surface to poll. */
  stats(): { inFlight: number; queued: number; tasks: number; busyMs: number } {
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      tasks: this.totalAcquired,
      busyMs: this.totalBusyMs,
    };
  }

  private onAcquired(): void {
    this.totalAcquired += 1;
    this.acquiredAt.push(this.now());
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
      this.onAcquired();
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
          this.onAcquired();
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
    const acquiredAt = this.acquiredAt.shift();
    if (acquiredAt !== undefined) this.totalBusyMs += Math.max(0, this.now() - acquiredAt);
    const next = this.queue.shift();
    next?.resolve();
  }
}

/** The one admission gate guarding every real worker spawn (`handler-runner.ts`'s default). */
let sharedWorkerAdmissionInstance: WorkerAdmission | undefined;

/** Lazily resolve the hardware profile after the gateway's boot fsync probe. */
export function sharedWorkerAdmission(): WorkerAdmission {
  sharedWorkerAdmissionInstance ??= new WorkerAdmission(workerMaxConcurrentFromEnv());
  return sharedWorkerAdmissionInstance;
}

/** Live counts + cumulative resource actuals on the shared production admission gate (issue #351/#528). */
export function workerAdmissionStats(): {
  inFlight: number;
  queued: number;
  tasks: number;
  busyMs: number;
} {
  return sharedWorkerAdmission().stats();
}
