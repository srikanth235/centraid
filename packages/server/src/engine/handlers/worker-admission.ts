// Caps app-handler worker spawns: ungated, a burst OOMs the host.

import { availableParallelism, totalmem } from "node:os";

import { unrefTimer } from "../../lib/unref-timer.js";

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

/** Explicit env beats host classification. */
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

// Strict priority for interactive waiters only (#883 C2) — no per-class concurrency; the bounded queue and wait give a loser a typed busy, not a silent starvation.
export type WorkerAdmissionClass = "interactive" | "background";

/** Absent means `interactive`: default to the one someone waits for. */
export const DEFAULT_ADMISSION_CLASS: WorkerAdmissionClass = "interactive";

/** Factory, not a subclass: `runHandler` maps it to `busy`. */
export function gatewayBusyError(
  message = "gateway busy: too many concurrent app handlers, try again shortly"
): Error {
  const err = new Error(message);
  err.name = "GatewayBusyError";
  return err;
}

interface QueueEntry {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
  admissionClass: WorkerAdmissionClass;
}

export class WorkerAdmission {
  private inFlight = 0;
  private readonly queue: QueueEntry[] = [];
  private totalAcquired = 0;
  private totalBusyMs = 0;
  private readonly acquiredAt: number[] = [];

  constructor(
    private readonly maxConcurrent: number = WORKER_MAX_CONCURRENT,
    private readonly maxQueue: number = WORKER_MAX_QUEUE,
    private readonly maxQueueWaitMs: number = WORKER_MAX_QUEUE_WAIT_MS,
    private readonly now: () => number = Date.now
  ) {}

  stats(): {
    inFlight: number;
    queued: number;
    tasks: number;
    busyMs: number;
    queuedInteractive: number;
    queuedBackground: number;
  } {
    const queuedInteractive = this.queue.filter(
      (entry) => entry.admissionClass === "interactive"
    ).length;
    return {
      inFlight: this.inFlight,
      queued: this.queue.length,
      tasks: this.totalAcquired,
      busyMs: this.totalBusyMs,
      queuedInteractive,
      queuedBackground: this.queue.length - queuedInteractive,
    };
  }

  private onAcquired(): void {
    this.totalAcquired += 1;
    this.acquiredAt.push(this.now());
  }

  async acquire(
    admissionClass: WorkerAdmissionClass = DEFAULT_ADMISSION_CLASS
  ): Promise<void> {
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
        admissionClass,
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
      unrefTimer(entry.timer);
      this.queue.push(entry);
    });
  }

  private takeNext(): QueueEntry | undefined {
    const index = this.queue.findIndex(
      (entry) => entry.admissionClass === "interactive"
    );
    if (index < 0) return this.queue.shift();
    return this.queue.splice(index, 1)[0];
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    const acquiredAt = this.acquiredAt.shift();
    if (acquiredAt !== undefined)
      this.totalBusyMs += Math.max(0, this.now() - acquiredAt);
    this.takeNext()?.resolve();
  }
}

let sharedWorkerAdmissionInstance: WorkerAdmission | undefined;

/** After the boot fsync probe, so the profile is resolved. */
export function sharedWorkerAdmission(): WorkerAdmission {
  sharedWorkerAdmissionInstance ??= new WorkerAdmission(
    workerMaxConcurrentFromEnv()
  );
  return sharedWorkerAdmissionInstance;
}

export function workerAdmissionStats(): ReturnType<WorkerAdmission["stats"]> {
  return sharedWorkerAdmission().stats();
}
