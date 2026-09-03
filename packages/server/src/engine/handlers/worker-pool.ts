import { Worker } from "node:worker_threads";

import { unrefTimer } from "../../lib/unref-timer.js";
import { isConstrainedWorkerHost } from "./worker-admission.js";
import type { WorkerHostCapacity } from "./worker-admission.js";

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

export const CONSTRAINED_WORKER_POOL_SIZE = 1;

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
  private refilling: ReturnType<typeof setImmediate> | undefined;

  constructor(
    private readonly workerFile: string,
    private readonly size: number = DEFAULT_WORKER_POOL_SIZE,
    private readonly resourceLimits: WorkerResourceLimits = workerResourceLimitsFromEnv()
  ) {}

  get warm(): number {
    return this.idle.length;
  }

  prewarm(): void {
    this.scheduleRefill();
  }

  acquire(): Worker {
    const spare = this.idle.shift();
    const worker = spare ?? this.spawn();
    worker.removeAllListeners();
    worker.ref();
    this.scheduleRefill();
    return worker;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refilling) clearImmediate(this.refilling);
    this.refilling = undefined;
    for (const worker of this.idle.splice(0)) {
      worker.removeAllListeners();
      void worker.terminate();
    }
  }

  private scheduleRefill(): void {
    if (this.disposed || this.refilling) return;
    if (this.idle.length >= this.size) return;
    this.refilling = setImmediate(() => {
      this.refilling = undefined;
      if (this.disposed) return;
      if (this.idle.length < this.size) this.idle.push(this.spawn());
      this.scheduleRefill();
    });
    unrefTimer(this.refilling);
  }

  private spawn(): Worker {
    const worker = new Worker(this.workerFile, {
      workerData: { pooled: true },
      resourceLimits: this.resourceLimits,
    });
    worker.unref();
    const drop = (): void => {
      const i = this.idle.indexOf(worker);
      if (i >= 0) this.idle.splice(i, 1);
    };
    worker.once("error", drop);
    worker.once("exit", drop);
    return worker;
  }
}
