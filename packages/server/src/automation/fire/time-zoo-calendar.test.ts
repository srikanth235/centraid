/*
 * The CALENDAR half of the time zoo (#839, gap G12): the two civil-clock
 * irregularities that are not DST — the leap day, and the ISO year that has
 * fifty-three weeks in it.
 *
 * Neither is covered by cron-match.test.ts or cron-cursor.test.ts, and both
 * are the classic shape of a scheduler defect that surfaces once every few
 * years: February 29 exists in one year in four (minus the century rule), and
 * an ISO year of 53 weeks breaks any "a year is 52 weeks" arithmetic exactly
 * once per cycle. 2026 is such a year — 2026-01-01 is a Thursday — which makes
 * it the adversarial case sitting immediately under the doctrine's own pinned
 * transition dates (docs/cron-timezone.md § "DST policy").
 *
 * Everything here runs in an explicit IANA zone, never host-local: per
 * docs/cron-timezone.md § "Matching", `cronMatches(expr, date, timeZone?)`
 * reads wall-clock fields in the resolved zone, and pinning the zone is what
 * keeps the assertions about the calendar rather than about the runner's TZ.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { AutomationTriggerCursor } from "@centraid/server/engine";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { wallClockFields } from "../cron-timezone.js";
import { dueInstants, readCronCursor } from "./cron-cursor.js";
import { cronMatches } from "./cron-match.js";

/** The zone every assertion below is stated in. */
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
    // 2028 is a leap year; 2027 is not. A `29 2` expression is not invalid —
    // it is simply unsatisfiable in a common year, which is the same shape as
    // the DST gap: no absolute instant carries that wall clock.
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
    // Divisible by 4 but not 400 → not a leap year. A `% 4` shortcut anywhere
    // in the field expansion would fire on 2100-02-29, a date that does not
    // exist. 2000 is the counter-case that keeps the rule from being read as
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
    // 2028-02-28 is a Monday, so the leap day is a Tuesday and March 1 a
    // Wednesday. A weekday derivation that skipped the inserted day would slip
    // every `* * * <dow>` automation by one for the rest of the year.
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
    // A gateway down from the 28th to March 1st missed ONE run in a leap year
    // and NONE in a common year. The count is what the member is shown, so the
    // leap day has to be counted as a day, not merely stepped over.
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
    // The premise every assertion below rests on, stated separately so a
    // failure distinguishes "our fixture year is wrong" from "cron is wrong".
    expect(isoWeek(new Date("2026-12-28T00:00:00.000Z"))).toStrictEqual({
      year: 2026,
      week: 53,
    });
    expect(isoWeek(new Date("2027-01-04T00:00:00.000Z"))).toStrictEqual({
      year: 2027,
      week: 1,
    });
    // 2025 is an ordinary 52-week ISO year — the contrast that makes 53 mean
    // something.
    expect(isoWeek(new Date("2025-12-29T00:00:00.000Z"))).toStrictEqual({
      year: 2026,
      week: 1,
    });
  });

  it("delivers 53 Monday fires across ISO year 2026, one per ISO week", () => {
    // ISO year 2026 runs Monday 2025-12-29 (W01) through Sunday 2027-01-03,
    // and its last Monday is 2026-12-28 (W53). A weekly automation must fire
    // on every one of them: 52 would silently drop a week from the member's
    // year.
    const mondays = tileDueInstants(
      "0 9 * * 1",
      "2025-12-29T08:59:00.000Z",
      "2026-12-28T09:00:00.000Z"
    );

    expect(mondays).toHaveLength(53);
    expect(mondays[0]?.toISOString()).toBe("2025-12-29T09:00:00.000Z");
    expect(mondays.at(-1)?.toISOString()).toBe("2026-12-28T09:00:00.000Z");
    // Every one of them is a Monday of ISO year 2026, week 1..53 in order.
    expect(mondays.map((day) => isoWeek(day).week)).toStrictEqual(
      Array.from({ length: 53 }, (_unused, index) => index + 1)
    );
    expect(new Set(mondays.map((day) => isoWeek(day).year))).toStrictEqual(
      new Set([2026])
    );
  });

  it("keeps a uniform seven-day step across the week-53 boundary", () => {
    // The boundary itself: W52 → W53 → next ISO year's W01. A re-anchoring bug
    // shows up as a 6- or 8-day step here and nowhere else in the year.
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
    // Vixie semantics: `dom` and `dow` are independent fields. A schedule
    // pinned to the 1st must land on the 1st of January 2027 regardless of
    // which ISO week that day belongs to.
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
