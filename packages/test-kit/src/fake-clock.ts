import { onTestFinished, vi } from "vitest";

export interface FakeClock {
  now: () => number;
  set: (time: number | string | Date) => void;
  advance: (ms: number) => Promise<void>;
  advanceSync: (ms: number) => void;
  pending: () => number;
  restore: () => void;
}

type FakeMethods = NonNullable<
  NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]
>;

export interface FakeClockOptions {
  toFake?: FakeMethods;
}

export function useFakeClock(
  initial?: number | string | Date,
  options: FakeClockOptions = {}
): FakeClock {
  vi.useFakeTimers(options.toFake ? { toFake: options.toFake } : undefined);
  if (initial !== undefined) vi.setSystemTime(initial);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    vi.useRealTimers();
  };
  onTestFinished(restore);
  return {
    now: () => Date.now(),
    set: (time) => vi.setSystemTime(time),
    advance: async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
    advanceSync: (ms) => {
      vi.advanceTimersByTime(ms);
    },
    pending: () => vi.getTimerCount(),
    restore,
  };
}
