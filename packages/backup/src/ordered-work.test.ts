import { describe, expect, test } from "vitest";

import {
  applyAvailableInOrder,
  applyInOrder,
  mapWithConcurrency,
} from "./ordered-work.js";

describe("ordered work", () => {
  test("does not start a later item before the previous item settles", async () => {
    let releaseFirst = () => {};
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started: number[] = [];
    const work = applyInOrder([1, 2, 3], (value) => {
      started.push(value);
      return value === 1 ? first : undefined;
    });

    await Promise.resolve();
    expect(started).toStrictEqual([1]);

    releaseFirst();
    await work;
    expect(started).toStrictEqual([1, 2, 3]);
  });

  test("closes an asynchronous source when ordered work fails", async () => {
    let closed = false;
    async function* values(): AsyncGenerator<number> {
      try {
        yield 1;
        yield 2;
      } finally {
        closed = true;
      }
    }

    await expect(
      applyAvailableInOrder(values(), (value) => {
        if (value === 2) throw new Error("stop");
      })
    ).rejects.toThrow("stop");
    expect(closed).toBe(true);
  });

  test("bounds independent work and preserves input result order", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const mapped = mapWithConcurrency([1, 2, 3], 2, async (value) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return value * 2;
    });

    await Promise.resolve();
    expect(peak).toBe(2);
    releases.shift()?.();
    await Promise.resolve();
    releases.shift()?.();
    await Promise.resolve();
    releases.shift()?.();
    await expect(mapped).resolves.toStrictEqual([2, 4, 6]);
  });

  test("rejects an invalid concurrency limit", async () => {
    await expect(mapWithConcurrency([], 0, () => undefined)).rejects.toThrow(
      "positive integer"
    );
  });
});
