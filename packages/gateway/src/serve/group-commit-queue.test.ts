import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupCommitQueue } from './group-commit-queue.js';

describe('GroupCommitQueue', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces arrivals inside the durability window and preserves order', async () => {
    vi.useFakeTimers();
    const queue = new GroupCommitQueue(8);
    const order: number[] = [];
    const first = queue.enqueue(() => order.push(1));
    await vi.advanceTimersByTimeAsync(4);
    const second = queue.enqueue(() => order.push(2));

    expect(order).toEqual([]);
    expect(queue.pendingCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(4);
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });

  it('isolates a failed write from the rest of the batch', async () => {
    vi.useFakeTimers();
    const queue = new GroupCommitQueue(8);
    const failed = queue.enqueue(() => {
      throw new Error('nope');
    });
    const failedExpectation = expect(failed).rejects.toThrow('nope');
    const succeeded = queue.enqueue(() => 42);

    await vi.advanceTimersByTimeAsync(8);
    await failedExpectation;
    await expect(succeeded).resolves.toBe(42);
  });

  it('hands ten writes in one arrival window to one shared transaction runner', async () => {
    vi.useFakeTimers();
    const batches: number[] = [];
    const queue = new GroupCommitQueue(5, (runs) => {
      batches.push(runs.length);
      return runs.map((run) => ({ ok: true as const, value: run() }));
    });
    const writes = Array.from({ length: 10 }, (_, index) => queue.enqueue(() => index));
    await vi.advanceTimersByTimeAsync(5);
    await expect(Promise.all(writes)).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(batches).toEqual([10]);
  });

  it('settles each result independently when the shared runner preserves a failed write', async () => {
    vi.useFakeTimers();
    const queue = new GroupCommitQueue(5, (runs) =>
      runs.map((run) => {
        try {
          return { ok: true as const, value: run() };
        } catch (error) {
          return { ok: false as const, error };
        }
      }),
    );
    const failed = queue.enqueue(() => {
      throw new Error('journal finalization failed');
    });
    const failedExpectation = expect(failed).rejects.toThrow('journal finalization failed');
    const succeeded = queue.enqueue(() => 42);

    await vi.advanceTimersByTimeAsync(5);
    await failedExpectation;
    await expect(succeeded).resolves.toBe(42);
  });
});
