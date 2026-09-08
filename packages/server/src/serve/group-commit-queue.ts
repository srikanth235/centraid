import { unrefTimer } from "../lib/unref-timer.js";

export type GroupCommitResult =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

// Per-phase cap (#659).
const DEFAULT_MAX_BATCH = 64;

/**
 * The longest a write may be held back to be batched with another (#659). The
 * window is sized from the measured cost of the fsync it exists to share, so
 * this is a ceiling for storage nobody has measured, never a target.
 */
export const GROUP_COMMIT_MAX_WINDOW_MS = 8;

/**
 * The arrival window for a host whose 4 KiB fsync costs `storageFsyncMs`.
 * Waiting longer than one commit takes buys no further amortisation and is
 * paid by every write that waits; an unmeasured host keeps the ceiling.
 */
export function groupCommitWindowMs(
  storageFsyncMs: number | undefined
): number {
  if (
    storageFsyncMs === undefined ||
    !Number.isFinite(storageFsyncMs) ||
    storageFsyncMs <= 0
  ) {
    return GROUP_COMMIT_MAX_WINDOW_MS;
  }
  return Math.min(
    GROUP_COMMIT_MAX_WINDOW_MS,
    Math.max(1, Math.round(storageFsyncMs))
  );
}

/**
 * Write coalescer: gathers arriving writes into one event-loop phase so
 * SQLite amortizes checkpoint work without crossing transaction boundaries.
 *
 * The window opens only under concurrency (#922 B7). A write arriving at an
 * idle queue is committed on the next MICROTASK: nothing is in flight to share
 * a commit with, so the window would be latency the member pays on every tap
 * for an amortisation that never happens. The microtask is what still
 * coalesces writes issued together without awaiting each other — they all land
 * before it runs, and share one commit at no added latency for any of them.
 * The `windowMs` window is kept for the case that genuinely needs it: once a
 * batch of more than one has committed, the writes arriving in that same turn
 * wait it out, because concurrency has been OBSERVED rather than assumed. It
 * closes again as soon as batches are back to one.
 */
export class GroupCommitQueue {
  private readonly pending: Array<{
    run: () => unknown;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private microtaskArmed = false;
  private concurrencyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly windowMs = GROUP_COMMIT_MAX_WINDOW_MS,
    private readonly runBatch?: (
      runs: readonly (() => unknown)[]
    ) => readonly GroupCommitResult[],
    private readonly maxBatch = DEFAULT_MAX_BATCH
  ) {}

  enqueue<T>(run: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
      // A full batch does not wait out its window (#659): re-arm at zero.
      if (this.pending.length >= this.maxBatch) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 0);
        unrefTimer(this.timer);
        return;
      }
      if (this.timer || this.microtaskArmed) return;
      if (this.concurrencyTimer === undefined) {
        this.microtaskArmed = true;
        queueMicrotask(() => {
          this.microtaskArmed = false;
          this.flush();
        });
        return;
      }
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      unrefTimer(this.timer);
    });
  }

  /** One turn in which arrivals wait out the window, because a batch larger
   *  than one has just proved there is something to amortize. */
  private observeConcurrency(): void {
    if (this.concurrencyTimer) clearTimeout(this.concurrencyTimer);
    this.concurrencyTimer = setTimeout(() => {
      this.concurrencyTimer = undefined;
    }, 0);
    unrefTimer(this.concurrencyTimer);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending.splice(0, this.maxBatch);
    if (batch.length > 1) this.observeConcurrency();
    if (this.runBatch && batch.length > 0) {
      try {
        const results = this.runBatch(batch.map((task) => task.run));
        if (results.length !== batch.length)
          throw new Error("group commit returned wrong result count");
        for (let index = 0; index < batch.length; index += 1) {
          const result = results[index]!;
          if (result.ok) batch[index]!.resolve(result.value);
          else batch[index]!.reject(result.error);
        }
      } catch (error) {
        for (const task of batch) task.reject(error);
      }
    } else {
      for (const task of batch) {
        try {
          task.resolve(task.run());
        } catch (error) {
          task.reject(error);
        }
      }
    }
    // Recursive enqueues get their own window, not an unbounded batch.
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      unrefTimer(this.timer);
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }
}
