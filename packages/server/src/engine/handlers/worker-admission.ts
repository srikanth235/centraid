/*
 * Cap app-handler worker spawns. Ungated, a burst OOMs the host. FIFO
 * queue bounded by length and wait; beyond that fail fast with busy.
 */

import { availableParallelism, totalmem } from "node:os";

export interface WorkerHostCapacity {
  cores: number;
  totalMemoryBytes: number;
}

function currentHostCapacity(): WorkerHostCapacity {
  return { cores: availableParallelism(), totalMemoryBytes: totalmem() };
}

export function isConstrainedWorkerHost(
  host: WorkerHostCapacity = currentHostCapacity()
): boolean {
  return host.cores <= 4 || host.totalMemoryBytes <= 4 * 1024 ** 3;
}

/** Explicit env always wins over host classification. */
export function workerMaxConcurrentFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  host: WorkerHostCapacity = currentHostCapacity()
): number {
  const resolvedProfile =
    env.CENTRAID_HARDWARE_PROFILE ?? env.CENTRAID_RESOLVED_HARDWARE_PROFILE;
  const constrained =
    resolvedProfile === "constrained" ||
    (resolvedProfile !== "standard" && isConstrainedWorkerHost(host));
  const fallback = constrained ? 2 : 8;
  const raw = env.CENTRAID_WORKER_MAX_CONCURRENT;
  if (raw === undefined || raw === "") return fallback;
  const parsed = Math.trunc(Number(raw));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, 32)
    : fallback;
}

export const WORKER_MAX_CONCURRENT = workerMaxConcurrentFromEnv();
export const WORKER_MAX_QUEUE = 16;
export const WORKER_MAX_QUEUE_WAIT_MS = 10_000;

/** Factory, not a subclass — `runHandler` maps this to `busy`, never a catch. */
export function gatewayBusyError(
  message = "gateway busy: too many concurrent app handlers, try again shortly"
): Error {
  const err = new Error(message);
  err.name = "GatewayBusyError";
  return err;
}

interface QueueEntry {
  resolve: () => void;
  timer: NodeJS.Timeout;
}

export class WorkerAdmission {
  private inFlight = 0;
  private readonly queue: QueueEntry[] = [];
  private totalAcquired = 0;
  private totalBusyMs = 0;
  /** Oldest-first acquire timestamps: pairing-independent running busyMs. */
  private readonly acquiredAt: number[] = [];

  constructor(
    private readonly maxConcurrent: number = WORKER_MAX_CONCURRENT,
    private readonly maxQueue: number = WORKER_MAX_QUEUE,
    private readonly maxQueueWaitMs: number = WORKER_MAX_QUEUE_WAIT_MS,
    private readonly now: () => number = Date.now
  ) {}

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
          reject(
            gatewayBusyError(
              "gateway busy: timed out waiting for a free worker slot"
            )
          );
        }, this.maxQueueWaitMs),
      };
      entry.timer.unref?.();
      this.queue.push(entry);
    });
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const acquiredAt = this.acquiredAt.shift();
    if (acquiredAt !== undefined)
      this.totalBusyMs += Math.max(0, this.now() - acquiredAt);
    const next = this.queue.shift();
    next?.resolve();
  }
}

let sharedWorkerAdmissionInstance: WorkerAdmission | undefined;

/** After the gateway's boot fsync probe so the hardware profile is resolved. */
export function sharedWorkerAdmission(): WorkerAdmission {
  sharedWorkerAdmissionInstance ??= new WorkerAdmission(
    workerMaxConcurrentFromEnv()
  );
  return sharedWorkerAdmissionInstance;
}

export function workerAdmissionStats(): {
  inFlight: number;
  queued: number;
  tasks: number;
  busyMs: number;
} {
  return sharedWorkerAdmission().stats();
}
