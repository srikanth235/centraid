// The element suites' fake clock (#656 Layer 4: `vi.useFakeTimers` is an oxlint
// error in tests). These assert the leak-proofing, not the happy path: a clock
// that advances is easy, a clock that restores itself after a throwing test is
// the whole point.
import { describe, expect, test } from "vitest";

import { useFakeClock } from "./fake-clock.test-support.js";

describe(useFakeClock, () => {
  test("advance runs timers and settles their microtasks", async () => {
    const start = Date.parse("2026-07-31T00:00:00Z");
    const clock = useFakeClock(start);
    const seen: string[] = [];
    setTimeout(() => {
      void Promise.resolve().then(() => seen.push("after-await"));
    }, 1_000);
    await clock.advance(1_000);
    expect(seen).toStrictEqual(["after-await"]);
    expect(clock.now()).toBe(start + 1_000);
  });

  test("advanceSync runs synchronous timer callbacks", () => {
    const clock = useFakeClock(0);
    let fired = 0;
    setTimeout(() => {
      fired += 1;
    }, 500);
    clock.advanceSync(500);
    expect(fired).toBe(1);
  });

  test("set jumps the clock without running the timers it passes", () => {
    const clock = useFakeClock(0);
    let fired = 0;
    setTimeout(() => {
      fired += 1;
    }, 1_000);
    clock.set(10_000);
    expect(fired).toBe(0);
    expect(clock.now()).toBe(10_000);
  });

  test("pending counts scheduled timers, so a leak can be asserted", () => {
    const clock = useFakeClock(0);
    expect(clock.pending()).toBe(0);
    setTimeout(() => undefined, 1_000);
    setTimeout(() => undefined, 2_000);
    expect(clock.pending()).toBe(2);
  });

  test("omitting the instant freezes the wall clock rather than jumping to 1970", () => {
    const before = Date.now();
    const clock = useFakeClock();
    expect(clock.now()).toBeGreaterThanOrEqual(before);
  });

  test("restore is idempotent and puts real timers back immediately", () => {
    const clock = useFakeClock(0);
    expect(Date.now()).toBe(0);
    clock.restore();
    clock.restore();
    expect(Date.now()).toBeGreaterThan(1_700_000_000_000);
  });

  // The leak the ban exists for, stated as an ordered pair: the first test
  // installs a clock and never restores it by hand, and the second — which
  // vitest runs immediately after, in the same file and worker — must still
  // see real time. Before the helper owned the restore, this second test hung.
  test("leak probe: a clock is installed and never restored by hand", () => {
    useFakeClock(0);
    expect(Date.now()).toBe(0);
  });

  test("leak probe: the next test in the file sees real time again", () => {
    expect(Date.now()).toBeGreaterThan(1_700_000_000_000);
  });
});
