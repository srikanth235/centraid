/*
 * CALENDAR half of the time zoo (#839, G12): leap day, and the ISO year of
 * 53 weeks. 2026 is such a year (2026-01-01 is a Thursday).
 *
 * Explicit IANA zone, never host-local: `cronMatches` reads wall-clock fields
 * in the resolved zone (docs/cron-timezone.md).
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { AutomationTriggerCursor } from "@centraid/server/engine";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { wallClockFields } from "../cron-timezone.js";
import { dueInstants, readCronCursor } from "./cron-cursor.js";
import { cronMatches } from "./cron-match.js";

const ZONE = "Etc/UTC";

/**
 * `dueInstants` caps one call at 31 days (MAX_SCAN_MINUTES). A year-long law
 * is therefore asserted over a TILING of half-open windows — which also proves
 * the `(from, to]` windows compose: a boundary that dropped or duplicated an
 * instant would change the count.
 */
const TILE_DAYS = 20;

function tileDueInstants(expr: string, fromIso: string, toIso: string): Date[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const out: Date[] = [];
  for (let start = from; start < to; start += TILE_DAYS * 86_400_000) {
    const end = Math.min(start + TILE_DAYS * 86_400_000, to);
    out.push(
      ...dueInstants([{ expr, timeZone: ZONE }], new Date(start), new Date(end))
    );
  }
  return out;
}

function cursorAt(positionMs: number): AutomationTriggerCursor {
  return {
    automationId: "zoo/calendar",
    triggerIndex: 0,
    sourceKind: "cron",
    positionJson: JSON.stringify(positionMs),
    skipped: 0,
    updatedAt: 0,
  };
}

/**
 * ISO-8601 week number of a UTC date. Written out rather than derived from the
 * code under test: it is the ORACLE the week-53 claims are checked against, so
 * borrowing the product's arithmetic would make the assertion circular.
 */
function isoWeek(date: Date): { year: number; week: number } {
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
  // Shift to the Thursday of this ISO week; the ISO year is that Thursday's.
  const dayNumber = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNumber + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNumber = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNumber + 3);
  const week =
    1 +
    Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return { year: isoYear, week };
}

describe("cron across the leap day", () => {
  beforeEach(() => {
    useFakeClock("2028-02-01T00:00:00.000Z");
  });

  it("fires a February 29 expression in a leap year and never in a common year", () => {
    const expr = "0 9 29 2 *";
    // `29 2` is not invalid — it is unsatisfiable in a common year.
    const leap = tileDueInstants(
      expr,
      "2028-02-20T00:00:00.000Z",
      "2028-03-03T00:00:00.000Z"
    );
    const common = tileDueInstants(
      expr,
      "2027-02-20T00:00:00.000Z",
      "2027-03-03T00:00:00.000Z"
    );

    expect(leap.map((instant) => instant.toISOString())).toStrictEqual([
      "2028-02-29T09:00:00.000Z",
    ]);
    expect(common).toStrictEqual([]);
  });

  it("honours the Gregorian century rule for 1900, 2000, and 2100", () => {
    // `% 4` would fire on 2100-02-29. 2000 is the counter-case against
    // "no century year is a leap year".
    const expr = "0 9 29 2 *";
    const counts = [1900, 2000, 2100].map(
      (year) =>
        tileDueInstants(
          expr,
          `${year}-02-20T00:00:00.000Z`,
          `${year}-03-03T00:00:00.000Z`
        ).length
    );
    expect(counts).toStrictEqual([0, 1, 0]);
  });

  it("keeps the weekday sequence unbroken across February 29", () => {
    // Skipping the inserted day would slip every `* * * <dow>` by one.
    const days = [
      "2028-02-28T09:00:00.000Z",
      "2028-02-29T09:00:00.000Z",
      "2028-03-01T09:00:00.000Z",
    ].map((iso) => wallClockFields(new Date(iso), ZONE).weekday);
    expect(days).toStrictEqual([1, 2, 3]);

    expect(
      cronMatches("0 9 * * 2", new Date("2028-02-29T09:00:00.000Z"), ZONE)
    ).toBe(true);
    expect(
      cronMatches("0 9 * * 1", new Date("2028-02-29T09:00:00.000Z"), ZONE)
    ).toBe(false);
  });

  it("advances the cursor over February 29 as a real missed run", () => {
    // Leap day is a missed run, not a day to step over.
    const leap = readCronCursor(
      [{ expr: "0 9 * * *", timeZone: ZONE }],
      cursorAt(Date.parse("2028-02-28T09:00:00.000Z")),
      new Date("2028-03-01T09:00:00.000Z")
    );
    const common = readCronCursor(
      [{ expr: "0 9 * * *", timeZone: ZONE }],
      cursorAt(Date.parse("2027-02-28T09:00:00.000Z")),
      new Date("2027-03-01T09:00:00.000Z")
    );

    expect(leap.elements).toStrictEqual([
      {
        position: String(Date.parse("2028-03-01T09:00:00.000Z")),
        occurredAt: Date.parse("2028-03-01T09:00:00.000Z"),
      },
    ]);
    expect(leap.skipped).toBe(1);
    expect(leap.gapReason).toBe("scheduler_gap");

    expect(common.elements).toStrictEqual([
      {
        position: String(Date.parse("2027-03-01T09:00:00.000Z")),
        occurredAt: Date.parse("2027-03-01T09:00:00.000Z"),
      },
    ]);
    expect(common.skipped).toBe(0);
    expect(common.gapReason).toBeUndefined();
  });
});

describe("cron across an ISO week-53 year", () => {
  beforeEach(() => {
    useFakeClock("2026-06-15T12:00:00.000Z");
  });

  it("agrees with the ISO oracle that 2026 carries a week 53", () => {
    // Premise, stated separately so a fixture-year failure is not "cron is wrong".
    expect(isoWeek(new Date("2026-12-28T00:00:00.000Z"))).toStrictEqual({
      year: 2026,
      week: 53,
    });
    expect(isoWeek(new Date("2027-01-04T00:00:00.000Z"))).toStrictEqual({
      year: 2027,
      week: 1,
    });
    // 2025 is an ordinary 52-week ISO year.
    expect(isoWeek(new Date("2025-12-29T00:00:00.000Z"))).toStrictEqual({
      year: 2026,
      week: 1,
    });
  });

  it("delivers 53 Monday fires across ISO year 2026, one per ISO week", () => {
    // ISO 2026 last Monday is 2026-12-28 (W53). 52 fires would silently drop a week.
    const mondays = tileDueInstants(
      "0 9 * * 1",
      "2025-12-29T08:59:00.000Z",
      "2026-12-28T09:00:00.000Z"
    );

    expect(mondays).toHaveLength(53);
    expect(mondays[0]?.toISOString()).toBe("2025-12-29T09:00:00.000Z");
    expect(mondays.at(-1)?.toISOString()).toBe("2026-12-28T09:00:00.000Z");
    // Week 1..53 in order, all ISO year 2026.
    expect(mondays.map((day) => isoWeek(day).week)).toStrictEqual(
      Array.from({ length: 53 }, (_unused, index) => index + 1)
    );
    expect(new Set(mondays.map((day) => isoWeek(day).year))).toStrictEqual(
      new Set([2026])
    );
  });

  it("keeps a uniform seven-day step across the week-53 boundary", () => {
    // Re-anchoring shows up as a 6- or 8-day step at W52 → W53 → W01.
    const boundary = tileDueInstants(
      "0 9 * * 1",
      "2026-12-14T08:59:00.000Z",
      "2027-01-11T09:00:00.000Z"
    );

    expect(boundary.map((day) => day.toISOString().slice(0, 10))).toStrictEqual(
      ["2026-12-14", "2026-12-21", "2026-12-28", "2027-01-04", "2027-01-11"]
    );
    const steps = boundary
      .slice(1)
      .map((day, index) => day.getTime() - (boundary[index] as Date).getTime());
    expect(new Set(steps)).toStrictEqual(new Set([7 * 86_400_000]));
    expect(boundary.map((day) => isoWeek(day))).toStrictEqual([
      { year: 2026, week: 51 },
      { year: 2026, week: 52 },
      { year: 2026, week: 53 },
      { year: 2027, week: 1 },
      { year: 2027, week: 2 },
    ]);
  });

  it("does not let the 53rd week disturb a day-of-month schedule", () => {
    // Vixie: `dom` and `dow` are independent — the 1st is the 1st regardless of ISO week.
    const firsts = tileDueInstants(
      "0 9 1 * *",
      "2026-11-30T00:00:00.000Z",
      "2027-01-02T00:00:00.000Z"
    );
    expect(firsts.map((day) => day.toISOString())).toStrictEqual([
      "2026-12-01T09:00:00.000Z",
      "2027-01-01T09:00:00.000Z",
    ]);
  });
});
