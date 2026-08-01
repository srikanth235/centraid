import { describe, expect, test } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { coalesceWork } from "./coalesce";

describe(coalesceWork, () => {
  test("a burst of signals produces one run after the burst goes quiet", async () => {
    const clock = useFakeClock(0);
    let runs = 0;
    const work = coalesceWork(() => {
      runs += 1;
      return Promise.resolve();
    }, 100);

    for (let index = 0; index < 200; index += 1) work.signal();
    await clock.advance(99);
    expect(runs).toBe(0);
    await clock.advance(1);
    expect(runs).toBe(1);
  });

  test("a signal during a run queues exactly one follow-up, however many arrive", async () => {
    const clock = useFakeClock(0);
    let runs = 0;
    let release: (() => void) | undefined;
    const work = coalesceWork(() => {
      runs += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    }, 100);

    work.signal();
    await clock.advance(100);
    expect(runs).toBe(1);

    for (let index = 0; index < 50; index += 1) work.signal();
    await clock.advance(1_000);
    // Still exactly one: the follow-up cannot start until the run settles.
    expect(runs).toBe(1);

    release!();
    await clock.advance(100);
    expect(runs).toBe(2);

    release!();
    await clock.advance(1_000);
    expect(runs).toBe(2);
  });

  test("a rejected run still lets the next signal through", async () => {
    const clock = useFakeClock(0);
    let runs = 0;
    const work = coalesceWork(() => {
      runs += 1;
      return Promise.reject(new Error("offline"));
    }, 100);

    work.signal();
    await clock.advance(100);
    expect(runs).toBe(1);
    work.signal();
    await clock.advance(100);
    expect(runs).toBe(2);
  });

  test("cancel drops the scheduled run", async () => {
    const clock = useFakeClock(0);
    let runs = 0;
    const work = coalesceWork(() => {
      runs += 1;
      return Promise.resolve();
    }, 100);

    work.signal();
    work.cancel();
    await clock.advance(1_000);
    expect(runs).toBe(0);
  });
});
