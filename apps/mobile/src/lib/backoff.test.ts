import { describe, expect, test } from "vitest";

import { seededRandom } from "@centraid/test-kit/random";

import { backoffSchedule } from "./backoff";

describe(backoffSchedule, () => {
  test("doubles to a ceiling and stays there", () => {
    const schedule = backoffSchedule({ baseMs: 2_000, maxMs: 60_000 });
    expect([
      schedule.next(),
      schedule.next(),
      schedule.next(),
      schedule.next(),
      schedule.next(),
      schedule.next(),
      schedule.next(),
    ]).toStrictEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]);
  });

  test("reset returns to the first delay so a reconnect is not made to wait", () => {
    const schedule = backoffSchedule({ baseMs: 2_000, maxMs: 60_000 });
    schedule.next();
    schedule.next();
    schedule.next();
    schedule.reset();
    expect(schedule.next()).toBe(2_000);
  });

  test("jitter spreads attempts without leaving the delay's neighbourhood", () => {
    const random = seededRandom(7).next;
    const schedule = backoffSchedule({
      baseMs: 2_000,
      maxMs: 60_000,
      jitter: 0.2,
      random,
    });
    const delays = Array.from({ length: 5 }, () => schedule.next());
    const bounds = [2_000, 4_000, 8_000, 16_000, 32_000];
    for (const [index, delay] of delays.entries()) {
      expect(delay).toBeGreaterThanOrEqual(bounds[index]! * 0.8);
      expect(delay).toBeLessThanOrEqual(bounds[index]! * 1.2);
    }
    expect(new Set(delays).size).toBe(delays.length);
  });
});
