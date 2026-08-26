import { onTestFinished, vi } from "vitest";

export interface FakeClock {
  now: () => number;
  /** Jump without running timers the jump passes over. */
  set: (time: number | string | Date) => void;
  /** Advance and drain microtasks. Prefer this when callbacks `await`. */
  advance: (ms: number) => Promise<void>;
  /** Do not use when callbacks `await` — they will not have resumed. */
  advanceSync: (ms: number) => void;
  /** Prove a leak; do not wait on this. */
  pending: () => number;
  restore: () => void;
}

/** Vitest's own `toFake` list; a widened copy compiles here and fails inside `vi.useFakeTimers`. */
type FakeMethods = NonNullable<
  NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]
>;

export interface FakeClockOptions {
  toFake?: FakeMethods;
}

/**
 * Restore is registered at install so a failed test cannot leak fake timers
 * (`vi.useFakeTimers` is banned; oxlint test-seam). Not for `beforeAll`.
 */
export function useFakeClock(
  initial?: number | string | Date,
  options: FakeClockOptions = {}
): FakeClock {
  vi.useFakeTimers(options.toFake ? { toFake: options.toFake } : undefined);
  // Omitting `initial` freezes at the real wall clock. Prefer an instant.
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
