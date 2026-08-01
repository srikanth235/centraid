export type GroupCommitResult =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

/**
 * A short write coalescer for the constrained gateway profile.
 *
 * SQLite WAL + synchronous=NORMAL defers durable WAL sync to checkpoints. The
 * queue gathers independently arriving handler writes for one short window and
 * executes them in a single event-loop phase, letting SQLite amortize that
 * checkpoint work without weakening Centraid's per-invocation transaction and
 * evidence boundaries by wrapping unrelated commands in one SQL transaction.
 */
/**
 * The most writes one event-loop phase may execute (issue #659 G11). Each is a
 * synchronous SQLite transaction, so an uncapped batch is an uncapped
 * event-loop stall — the exact thing the low-end lag budget measures.
 */
const DEFAULT_MAX_BATCH = 64;

export class GroupCommitQueue {
  private readonly pending: Array<{
    run: () => unknown;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly windowMs = 8,
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
      // A full batch does not wait out the rest of its window (issue #659 G11):
      // under a burst the window would otherwise keep collecting, and the
      // single event-loop phase that executes the batch would block for as long
      // as the burst lasted. Re-arm at zero so the batch runs next tick.
      if (this.pending.length >= this.maxBatch) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 0);
        this.timer.unref?.();
        return;
      }
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.windowMs);
        this.timer.unref?.();
      }
    });
  }

  /** Drain immediately during orderly shutdown. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    // Never execute more than one batch's worth in a single phase; the
    // remainder re-arms below and gets its own window (issue #659 G11).
    const batch = this.pending.splice(0, this.maxBatch);
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
    // A callback can enqueue recursively. Give that work its own durability
    // window instead of extending this batch without a bound.
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      this.timer.unref?.();
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }
}
