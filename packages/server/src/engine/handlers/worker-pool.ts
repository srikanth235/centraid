/*
 * Warm pool for handler dispatch (#404, #922 B3). A worker is a REUSED thread
 * that gets a fresh module graph per run: the thread boundary plus the hard
 * timeout in the caller is what the isolation ruling buys, and disposal after
 * every run was the implementation of that, never the property.
 *
 * WHAT REUSE STILL MAY NOT CROSS is the sandbox. `installWorkerSandbox` is
 * thread-wide, one-way, and per lane, so a parked worker carries the SANDBOX
 * KEY it was installed for and is handed back only for a run with the same
 * key. A worker that has never run carries no key and matches anything.
 */

import { Worker } from "node:worker_threads";

import { unrefTimer } from "../../lib/unref-timer.js";
import { bumpEngineWorkCounter } from "./work-counters.js";
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

/** Not zero (#659): a constrained host is where a cold boot hurts most. */
export const CONSTRAINED_WORKER_POOL_SIZE = 1;

/** `CENTRAID_WORKER_POOL_SIZE=0` disables warming: every acquire is cold. */
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

/** A parked worker and the sandbox lane it is already committed to. */
interface Spare {
  readonly worker: Worker;
  /** Undefined until the worker has run once and installed its sandbox. */
  readonly key: string | undefined;
}

export class WorkerPool {
  private readonly idle: Spare[] = [];
  /** Threads handed out and not yet released or retired. Counted so a refill
   *  never spawns a COLD spare for a slot a WARM thread is about to fill. */
  private outstanding = 0;
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

  /**
   * A worker whose sandbox already matches `key`, else an unused spare, else a
   * fresh thread. No pool listeners survive: the caller owns the lifecycle
   * until it calls `release` or `retire`.
   */
  acquire(key: string): Worker {
    const reusable = this.idle.findIndex((spare) => spare.key === key);
    const index = reusable >= 0 ? reusable : this.idle.findIndex((s) => !s.key);
    const spare = index >= 0 ? this.idle.splice(index, 1)[0] : undefined;
    const worker = spare?.worker ?? this.spawn();
    this.outstanding += 1;
    worker.removeAllListeners();
    // Spares park unref'd; a working worker holds the loop open.
    worker.ref();
    // Replenish off the hot path.
    this.scheduleRefill();
    return worker;
  }

  /**
   * Parks a worker that finished a run cleanly. Over-capacity threads are
   * terminated rather than kept: the pool size is the number of warm threads
   * the host agreed to pay for.
   */
  release(worker: Worker, key: string): void {
    if (this.disposed || this.idle.length >= this.size) {
      this.retire(worker);
      return;
    }
    this.outstanding = Math.max(0, this.outstanding - 1);
    worker.removeAllListeners();
    worker.unref();
    this.park({ worker, key });
  }

  /** Timeout, worker error, or a resource-limit breach: the thread dies. */
  retire(worker: Worker): void {
    this.outstanding = Math.max(0, this.outstanding - 1);
    worker.removeAllListeners();
    void worker.terminate();
    this.scheduleRefill();
  }

  dispose(): void {
    this.disposed = true;
    if (this.refilling) clearImmediate(this.refilling);
    this.refilling = undefined;
    for (const spare of this.idle.splice(0)) {
      spare.worker.removeAllListeners();
      void spare.worker.terminate();
    }
  }

  /**
   * REFILL YIELDS BETWEEN SPAWNS (#883 C2). `new Worker()` is main-thread work
   * and a microtask is NOT off the main thread, so batching the top-up blocks
   * every pending request. One spare per `setImmediate`, one in flight.
   */
  private scheduleRefill(): void {
    if (this.disposed || this.refilling) return;
    if (this.idle.length >= this.warmTarget) return;
    this.refilling = setImmediate(() => {
      this.refilling = undefined;
      if (this.disposed) return;
      if (this.idle.length < this.warmTarget) {
        this.park({ worker: this.spawn(), key: undefined });
      }
      this.scheduleRefill();
    });
    unrefTimer(this.refilling);
  }

  /** Threads out on a run come BACK warm (#922 B3), so they already hold the
   *  slots they occupy: topping up to `size` regardless would spawn a cold
   *  spare per dispatch and then throw the warm thread away on release. */
  private get warmTarget(): number {
    return Math.max(0, this.size - this.outstanding);
  }

  private spawn(): Worker {
    // #927 P2: the ONE place a handler thread is created — `acquire()` and the
    // refill both come through here, so one bump counts every spawn.
    bumpEngineWorkCounter("workerSpawns");
    const worker = new Worker(this.workerFile, {
      workerData: { pooled: true },
      resourceLimits: this.resourceLimits,
    });
    worker.unref();
    return worker;
  }

  /** Evict on death, never auto-refill from the listener: a boot crash would
   *  spin a respawn loop. The next acquire re-tops the set. */
  private park(spare: Spare): void {
    const drop = (): void => {
      const i = this.idle.findIndex((s) => s.worker === spare.worker);
      if (i >= 0) this.idle.splice(i, 1);
    };
    spare.worker.once("error", drop);
    spare.worker.once("exit", drop);
    this.idle.push(spare);
  }
}
