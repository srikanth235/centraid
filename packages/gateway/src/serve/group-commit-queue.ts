export type GroupCommitResult = { ok: true; value: unknown } | { ok: false; error: unknown };

/**
 * A short write coalescer for the constrained gateway profile.
 *
 * SQLite WAL + synchronous=NORMAL defers durable WAL sync to checkpoints. The
 * queue gathers independently arriving handler writes for one short window and
 * executes them in a single event-loop phase, letting SQLite amortize that
 * checkpoint work without weakening Centraid's per-invocation transaction and
 * evidence boundaries by wrapping unrelated commands in one SQL transaction.
 */
export class GroupCommitQueue {
  private readonly pending: Array<{
    run: () => unknown;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  }> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly windowMs = 8,
    private readonly runBatch?: (runs: readonly (() => unknown)[]) => readonly GroupCommitResult[],
  ) {}

  enqueue<T>(run: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run,
        resolve: (value) => resolve(value as T),
        reject,
      });
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
    const batch = this.pending.splice(0);
    if (this.runBatch && batch.length > 0) {
      try {
        const results = this.runBatch(batch.map((task) => task.run));
        if (results.length !== batch.length)
          throw new Error('group commit returned wrong result count');
        for (let index = 0; index < batch.length; index += 1) {
          const result = results[index]!;
          if (result.ok) batch[index]!.resolve(result.value);
          else batch[index]!.reject(result.error);
        }
      } catch (err) {
        for (const task of batch) task.reject(err);
      }
    } else {
      for (const task of batch) {
        try {
          task.resolve(task.run());
        } catch (err) {
          task.reject(err);
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
