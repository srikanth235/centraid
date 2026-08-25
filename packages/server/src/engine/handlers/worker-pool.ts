/*
 * Warm-spare pool for app-handler dispatch (#404). ISOLATION FIRST: handler
 * code arrives by dynamic `import()`, so a worker's module registry keeps every
 * handler it ran. NEVER reuse a worker across handlers — pooling pre-boots
 * single-use spares and must never widen that boundary.
 */

import { Worker } from "node:worker_threads";

import { isConstrainedWorkerHost } from "./worker-admission.js";
import type { WorkerHostCapacity } from "./worker-admission.js";

/** Keep in step with `handler-runner.ts`'s spawn. */
export interface WorkerResourceLimits {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
}

const DEFAULT_LIMITS: WorkerResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
};

export function workerResourceLimitsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  host?: WorkerHostCapacity
): WorkerResourceLimits {
  const resolvedProfile =
    env.CENTRAID_HARDWARE_PROFILE ?? env.CENTRAID_RESOLVED_HARDWARE_PROFILE;
  const constrained =
    resolvedProfile === "constrained" ||
    (resolvedProfile !== "standard" && isConstrainedWorkerHost(host));
  const fallbackOld = constrained ? 128 : DEFAULT_LIMITS.maxOldGenerationSizeMb;
  const fallbackYoung = constrained
    ? 16
    : DEFAULT_LIMITS.maxYoungGenerationSizeMb;
  const parse = (
    raw: string | undefined,
    fallback: number,
    ceiling: number
  ): number => {
    if (raw === undefined || raw === "") return fallback;
    const value = Math.trunc(Number(raw));
    return Number.isFinite(value) && value >= 8
      ? Math.min(value, ceiling)
      : fallback;
  };
  return {
    maxOldGenerationSizeMb: parse(
      env.CENTRAID_WORKER_MAX_OLD_GENERATION_MB,
      fallbackOld,
      1024
    ),
    maxYoungGenerationSizeMb: parse(
      env.CENTRAID_WORKER_MAX_YOUNG_GENERATION_MB,
      fallbackYoung,
      128
    ),
  };
}

export const DEFAULT_WORKER_POOL_SIZE = 2;

/** Not zero (#659): the constrained host is where a cold boot hurts most. */
export const CONSTRAINED_WORKER_POOL_SIZE = 1;

/** `CENTRAID_WORKER_POOL_SIZE=0` disables warming; every acquire spawns cold. */
export function workerPoolSizeFromEnv(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env.CENTRAID_WORKER_POOL_SIZE;
  const resolvedProfile =
    env.CENTRAID_HARDWARE_PROFILE ?? env.CENTRAID_RESOLVED_HARDWARE_PROFILE;
  const fallback =
    resolvedProfile === "constrained" ||
    (resolvedProfile !== "standard" && isConstrainedWorkerHost())
      ? CONSTRAINED_WORKER_POOL_SIZE
      : DEFAULT_WORKER_POOL_SIZE;
  if (raw === undefined || raw === "") return fallback;
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(n, 8);
}

export class WorkerPool {
  private readonly idle: Worker[] = [];
  private disposed = false;

  constructor(
    private readonly workerFile: string,
    private readonly size: number = DEFAULT_WORKER_POOL_SIZE,
    private readonly resourceLimits: WorkerResourceLimits = workerResourceLimitsFromEnv()
  ) {}

  get warm(): number {
    return this.idle.length;
  }

  prewarm(): void {
    this.refill();
  }

  /** No pool listeners survive: the caller owns the worker's lifecycle. */
  acquire(): Worker {
    const spare = this.idle.shift();
    const worker = spare ?? this.spawn();
    worker.removeAllListeners();
    // Spares park unref'd; a working worker must hold the loop open.
    worker.ref();
    // Replenish off the hot path so bursts keep finding spares.
    queueMicrotask(() => this.refill());
    return worker;
  }

  dispose(): void {
    this.disposed = true;
    for (const worker of this.idle.splice(0)) {
      worker.removeAllListeners();
      void worker.terminate();
    }
  }

  private refill(): void {
    if (this.disposed) return;
    while (this.idle.length < this.size) {
      this.idle.push(this.spawn());
    }
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerFile, {
      workerData: { pooled: true },
      resourceLimits: this.resourceLimits,
    });
    worker.unref();
    // Evict on death, but never auto-refill here: a boot crash would spin a
    // respawn loop. The next acquire/prewarm re-tops the set.
    const drop = (): void => {
      const i = this.idle.indexOf(worker);
      if (i >= 0) this.idle.splice(i, 1);
    };
    worker.once("error", drop);
    worker.once("exit", drop);
    return worker;
  }
}
