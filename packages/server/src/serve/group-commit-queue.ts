import { unrefTimer } from "../lib/unref-timer.js";

export type GroupCommitResult =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

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
      if (this.pending.length >= this.maxBatch) {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 0);
        unrefTimer(this.timer);
        return;
      }
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), this.windowMs);
        unrefTimer(this.timer);
      }
    });
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
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
    if (this.pending.length > 0 && !this.timer) {
      this.timer = setTimeout(() => this.flush(), this.windowMs);
      unrefTimer(this.timer);
    }
  }

  pendingCount(): number {
    return this.pending.length;
  }
}
