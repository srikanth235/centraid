import { describe, expect, test } from "vitest";

import { compareToBudget, measureWallClock } from "./suite-wall-clock.mjs";

const file = (runtime, start = 0) => ({
  perfStats: { runtime },
  startTime: start,
  endTime: start + runtime,
});

describe("suite wall-clock measurement", () => {
  test("sums per-file runtime rather than the run's elapsed time", () => {
    expect(
      measureWallClock({
        testResults: [file(1000, 0), file(500, 200)],
      })
    ).toEqual({ totalMs: 1500, files: 2 });
  });

  test("falls back to start/end when a runner omits perfStats", () => {
    expect(
      measureWallClock({
        testResults: [{ startTime: 100, endTime: 400 }],
      })
    ).toEqual({ totalMs: 300, files: 1 });
  });

  test("a file with no usable timing contributes zero, never NaN", () => {
    const measured = measureWallClock({
      testResults: [{ startTime: 400, endTime: 100 }, {}, file(250)],
    });
    expect(measured).toEqual({ totalMs: 250, files: 3 });
  });

  test("an unreadable report is null, so the caller can say 'not measured'", () => {
    expect(measureWallClock(null)).toBeNull();
    expect(measureWallClock({})).toBeNull();
    expect(measureWallClock({ testResults: "nope" })).toBeNull();
  });
});

describe("suite wall-clock budget", () => {
  test("passes at the ceiling and fails one millisecond over it", () => {
    expect(compareToBudget(1000, { budgetMs: 1000 }).ok).toBe(true);
    expect(compareToBudget(1001, { budgetMs: 1000 }).ok).toBe(false);
  });

  test("the failure names the remedy, not just the number", () => {
    const verdict = compareToBudget(2000, { budgetMs: 1000 });
    expect(verdict.message).toContain("Make the suite faster");
    expect(verdict.message).toContain("approvedDeviation");
  });

  test("a missing or nonsensical ceiling fails rather than passing vacuously", () => {
    expect(compareToBudget(10, {}).ok).toBe(false);
    expect(compareToBudget(10, { budgetMs: 0 }).ok).toBe(false);
    expect(compareToBudget(10, { budgetMs: "fast" }).ok).toBe(false);
  });

  test("reports remaining slack so tightening is an informed edit", () => {
    expect(compareToBudget(600, { budgetMs: 1000 }).slackMs).toBe(400);
  });
});
