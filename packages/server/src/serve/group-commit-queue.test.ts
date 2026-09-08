import { describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import {
  GROUP_COMMIT_MAX_WINDOW_MS,
  GroupCommitQueue,
  groupCommitWindowMs,
} from "./group-commit-queue.js";

describe(GroupCommitQueue, () => {
  it("commits a lone write without waiting the group-commit window", async () => {
    useFakeClock();
    const queue = new GroupCommitQueue(8);
    const order: number[] = [];
    const lone = queue.enqueue(() => order.push(1));

    // No clock advance: an idle queue has nothing to amortize against, so the
    // write commits on the next microtask and never sees the window.
    await expect(lone).resolves.toBe(1);
    expect(order).toStrictEqual([1]);
    expect(queue.pendingCount()).toBe(0);
  });

  it("keeps the window shut for writes that each wait for the last one", async () => {
    useFakeClock();
    const queue = new GroupCommitQueue(8);
    const order: number[] = [];
    // Written out rather than looped: each write must WAIT for the last one,
    // which is the shape the window must stay shut for.
    await queue.enqueue(() => order.push(1));
    await queue.enqueue(() => order.push(2));
    await queue.enqueue(() => order.push(3));

    expect(order).toStrictEqual([1, 2, 3]);
  });

  it("shares one commit between writes issued without awaiting each other, and preserves order", async () => {
    useFakeClock();
    const batches: number[] = [];
    const queue = new GroupCommitQueue(8, (runs) => {
      batches.push(runs.length);
      return runs.map((run) => ({ ok: true as const, value: run() }));
    });
    const order: number[] = [];
    const concurrent = [1, 2, 3].map((index) =>
      queue.enqueue(() => order.push(index))
    );

    expect(queue.pendingCount()).toBe(3);
    await Promise.all(concurrent);
    expect(order).toStrictEqual([1, 2, 3]);
    expect(batches).toStrictEqual([3]);
  });

  it("opens the window for the turn after a batch larger than one has committed", async () => {
    const clock = useFakeClock();
    const queue = new GroupCommitQueue(8);
    const order: number[] = [];
    await Promise.all([
      queue.enqueue(() => order.push(1)),
      queue.enqueue(() => order.push(2)),
    ]);

    // Concurrency observed: the next arrival waits out the window instead of
    // committing alone.
    const third = queue.enqueue(() => order.push(3));
    expect(order).toStrictEqual([1, 2]);
    expect(queue.pendingCount()).toBe(1);
    await clock.advance(8);
    await third;
    expect(order).toStrictEqual([1, 2, 3]);
  });

  it("isolates a failed write from the rest of the batch", async () => {
    useFakeClock();
    const queue = new GroupCommitQueue(8);
    const failed = queue.enqueue(() => {
      throw new Error("nope");
    });
    const failure = failed.then(
      () => new Error("write unexpectedly succeeded"),
      (error) => error
    );
    const succeeded = queue.enqueue(() => 42);

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("nope");
    await expect(succeeded).resolves.toBe(42);
  });

  it("hands ten writes issued together to one shared transaction runner", async () => {
    useFakeClock();
    const batches: number[] = [];
    const queue = new GroupCommitQueue(5, (runs) => {
      batches.push(runs.length);
      return runs.map((run) => ({ ok: true as const, value: run() }));
    });
    const writes = Array.from({ length: 10 }, (_, index) =>
      queue.enqueue(() => index)
    );
    await expect(Promise.all(writes)).resolves.toStrictEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(batches).toStrictEqual([10]);
  });

  it("settles each result independently when the shared runner preserves a failed write", async () => {
    useFakeClock();
    const queue = new GroupCommitQueue(5, (runs) =>
      runs.map((run) => {
        try {
          return { ok: true as const, value: run() };
        } catch (error) {
          return { ok: false as const, error };
        }
      })
    );
    const failed = queue.enqueue(() => {
      throw new Error("journal finalization failed");
    });
    const failure = failed.then(
      () => new Error("write unexpectedly succeeded"),
      (error) => error
    );
    const succeeded = queue.enqueue(() => 42);

    const error = await failure;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("journal finalization failed");
    await expect(succeeded).resolves.toBe(42);
  });
});

describe(groupCommitWindowMs, () => {
  it("is the measured cost of the commit it amortizes, capped at the ceiling", () => {
    expect(groupCommitWindowMs(0.4)).toBe(1);
    expect(groupCommitWindowMs(3.2)).toBe(3);
    expect(groupCommitWindowMs(20)).toBe(GROUP_COMMIT_MAX_WINDOW_MS);
  });

  it("keeps the ceiling for storage nobody measured", () => {
    expect(groupCommitWindowMs(undefined)).toBe(GROUP_COMMIT_MAX_WINDOW_MS);
    expect(groupCommitWindowMs(Number.NaN)).toBe(GROUP_COMMIT_MAX_WINDOW_MS);
    expect(groupCommitWindowMs(0)).toBe(GROUP_COMMIT_MAX_WINDOW_MS);
  });
});
