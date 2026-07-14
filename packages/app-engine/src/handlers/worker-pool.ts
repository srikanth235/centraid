/*
 * Warm-spare worker pool for app-handler dispatch (issue #404 mobile fast
 * path). Every `centraid_read` / `centraid_write` used to pay the full cost of
 * spinning up a fresh `node:worker_threads` Worker — thread creation plus this
 * repo's worker-runner module evaluation (and, under the tsx test loader, the
 * loader re-registration) — on the request's critical path, ~10-30ms+ each.
 *
 * ISOLATION FIRST. Handler code loads via dynamic `import()` inside the
 * worker, so a worker's module registry accumulates whatever handlers it has
 * run; reusing one worker across two handlers would let app A's module-level
 * state leak into app B (and mask A's own between-call state). This pool does
 * NOT reuse workers for that reason. Instead it keeps N **warm spares**:
 * workers that have finished booting (thread + runner module evaluated) and
 * are parked waiting for a single `run` message. `acquire()` hands out a warm
 * spare and immediately schedules a replacement, so the boot cost is paid on a
 * spare thread while a previous request runs — off the acquiring request's
 * critical path. The acquired worker still runs EXACTLY ONE handler and is
 * then terminated by the caller: isolation is byte-for-byte identical to the
 * old spawn-per-run model, we just move the spawn earlier in time.
 *
 * The pool is intentionally tiny and self-healing: a warm spare that dies
 * while idle is dropped from the ready set (a fresh one is spun up on the next
 * acquire/prewarm), and because each run owns its worker's lifecycle a crash
 * mid-run never poisons the spares.
 */

import { Worker } from 'node:worker_threads';

/** Resource caps mirrored from the pre-pool spawn (handler-runner.ts). */
export interface WorkerResourceLimits {
  maxOldGenerationSizeMb: number;
  maxYoungGenerationSizeMb: number;
}

const DEFAULT_LIMITS: WorkerResourceLimits = {
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
};

/** Default warm-spare count when unset by env/option (small: 2 threads). */
export const DEFAULT_WORKER_POOL_SIZE = 2;

/**
 * Read the configured warm-spare count from the environment, clamped to a
 * sane band. `CENTRAID_WORKER_POOL_SIZE=0` disables warming (every acquire
 * spawns cold) — useful for memory-constrained hosts or debugging.
 */
export function workerPoolSizeFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CENTRAID_WORKER_POOL_SIZE;
  if (raw === undefined || raw === '') return DEFAULT_WORKER_POOL_SIZE;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_WORKER_POOL_SIZE;
  // A very large pool defeats the point (idle memory) — cap it.
  return Math.min(n, 8);
}

/**
 * A pool of pre-booted, single-use worker threads. `acquire()` returns a
 * worker that has (or is finishing) its boot and is waiting for a `run`
 * message; the caller posts the handler request and owns the worker's
 * lifecycle from there (listeners, timeout, terminate).
 */
export class WorkerPool {
  private readonly idle: Worker[] = [];
  private disposed = false;

  constructor(
    private readonly workerFile: string,
    private readonly size: number = DEFAULT_WORKER_POOL_SIZE,
    private readonly resourceLimits: WorkerResourceLimits = DEFAULT_LIMITS,
  ) {}

  /** Live warm-spare count — for a health/metrics surface or tests. */
  get warm(): number {
    return this.idle.length;
  }

  /** Fill the ready set up to `size`. Idempotent; safe to call repeatedly. */
  prewarm(): void {
    this.refill();
  }

  /**
   * Hand out a warm spare (or spawn one cold if the set is empty / warming is
   * disabled), then schedule a replacement so the next acquire finds a spare.
   * The returned worker has NO listeners attached by the pool — the caller
   * attaches its own run/error/exit/timeout handling.
   */
  acquire(): Worker {
    const spare = this.idle.shift();
    const worker = spare ?? this.spawn();
    // Strip the idle-phase drop listeners; the caller owns this worker now.
    worker.removeAllListeners();
    // A parked spare is unref'd so it can't hold the process open; once it's
    // doing real work it must keep the loop alive until it finishes.
    worker.ref();
    // Replenish off the hot path so a burst of sequential dispatches keeps
    // finding warm spares rather than paying cold-start each time.
    queueMicrotask(() => this.refill());
    return worker;
  }

  /** Terminate every warm spare and stop refilling (host shutdown / tests). */
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
    // A warm spare must not keep the host process alive just by sitting idle.
    worker.unref();
    // If a spare dies before it is acquired, quietly evict it. We do NOT
    // auto-refill from here: a worker that crashes on boot would otherwise
    // spin a tight respawn loop. The next acquire/prewarm re-tops the set.
    const drop = (): void => {
      const i = this.idle.indexOf(worker);
      if (i >= 0) this.idle.splice(i, 1);
    };
    worker.once('error', drop);
    worker.once('exit', drop);
    return worker;
  }
}
