import { onTestFinished, vi } from 'vitest';

export interface FakeClock {
  now(): number;
  set(time: number | string | Date): void;
  advance(ms: number): Promise<void>;
}

/** Install a deterministic fake clock and always restore real timers. */
export function useFakeClock(initial: number | string | Date = 0): FakeClock {
  vi.useFakeTimers();
  vi.setSystemTime(initial);
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return {
    now: () => Date.now(),
    set: (time) => vi.setSystemTime(time),
    advance: async (ms) => {
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}
