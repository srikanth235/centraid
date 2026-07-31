import { onTestFinished, vi } from "vitest";

export interface FakeClock {
  /** The current fake time in epoch milliseconds. */
  now: () => number;
  /** Jump the clock without running any timer that the jump passes over. */
  set: (time: number | string | Date) => void;
  /**
   * Advance the clock, running every timer it passes and draining the
   * microtask queue between them. This is the form almost every test wants:
   * a timer callback that awaits is only observable after its promises settle.
   */
  advance: (ms: number) => Promise<void>;
  /**
   * Synchronous advance. Only for code whose timer callbacks are themselves
   * synchronous — an `await` inside a callback will not have resumed when this
   * returns, which is exactly the trap `advance` avoids.
   */
  advanceSync: (ms: number) => void;
  /** Number of timers currently scheduled. Use to prove a leak, not to wait. */
  pending: () => number;
  /** Restore real timers early, before the test ends. */
  restore: () => void;
}

/**
 * Derived from Vitest's own signature rather than restated as `string[]`:
 * the fakeable method names are the runner's list, and a widened copy here
 * would compile at the call site and fail inside `vi.useFakeTimers`.
 */
type FakeMethods = NonNullable<
  NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]
>;

export interface FakeClockOptions {
  /**
   * Restrict which globals are faked, e.g. `["Date"]` to freeze the wall clock
   * while leaving `setTimeout` real. Vitest's default fakes the whole timer
   * surface.
   */
  toFake?: FakeMethods;
}

/**
 * Install a deterministic fake clock and always restore real timers.
 *
 * The restore is the point. A test that calls `vi.useFakeTimers()` and then
 * fails before its `afterEach` — or never wrote one — leaves fake timers
 * installed for every later test in the file, which turns unrelated tests into
 * hangs that report as timeouts. Registering the restore at install time makes
 * that unrepresentable, so `vi.useFakeTimers` is banned in test files (see the
 * test-seam override in `oxlint.config.ts`).
 *
 * Callable from a test body or from `beforeEach`; `onTestFinished` is
 * meaningless in `beforeAll`, so a file-lifetime clock is out of scope by
 * design.
 */
export function useFakeClock(
  initial?: number | string | Date,
  options: FakeClockOptions = {}
): FakeClock {
  vi.useFakeTimers(options.toFake ? { toFake: options.toFake } : undefined);
  // Omitting `initial` freezes the clock wherever the wall clock stood, which
  // is Vitest's own default and the only faithful migration for the tests that
  // called `vi.useFakeTimers()` bare. Prefer passing an instant: a test whose
  // starting point is "whenever CI ran" is deterministic in its *deltas* only.
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
