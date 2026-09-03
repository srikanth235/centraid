import { beforeEach, describe, expect, it } from "vitest";

import type { AutomationTriggerCursor } from "@centraid/server/engine";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { wallClockFields, wallClockMinuteKey } from "../cron-timezone.js";
import { dueInstants, readCronCursor } from "./cron-cursor.js";
import { cronMatches } from "./cron-match.js";

const MINUTE = 60_000;
const DAY = 1_440 * MINUTE;

const ZONE = "Etc/UTC";

const TILE_MS = 20 * DAY;

function tileDueInstants(
  expr: string,
  fromIso: string,
  toIso: string,
  zone: string = ZONE
): Date[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const out: Date[] = [];
  for (let start = from; start < to; start += TILE_MS) {
    const end = Math.min(start + TILE_MS, to);
    out.push(
      ...dueInstants([{ expr, timeZone: zone }], new Date(start), new Date(end))
    );
  }
  return out;
}

function cursorAt(positionMs: number): AutomationTriggerCursor {
  return {
    automationId: "calendar/one",
    triggerIndex: 0,
    sourceKind: "cron",
    positionJson: JSON.stringify(positionMs),
    skipped: 0,
    updatedAt: 0,
  };
}

function dates(instants: readonly Date[]): string[] {
  return instants.map((instant) => instant.toISOString().slice(0, 10));
}

function matchingDays(expr: string, year: number, hour: number): string[] {
  const out: string[] = [];
  const end = Date.UTC(year + 1, 0, 1);
  for (let day = Date.UTC(year, 0, 1); day < end; day += DAY) {
    const candidate = new Date(day + hour * 60 * MINUTE);
    if (cronMatches(expr, candidate, ZONE)) {
      out.push(candidate.toISOString().slice(0, 10));
    }
  }
  return out;
}

describe("month-length boundaries", () => {
  beforeEach(() => {
    useFakeClock("2026-06-15T12:00:00.000Z");
  });

  it("fires a day-31 expression in exactly the seven long months of 2026", () => {
    expect(matchingDays("0 3 31 * *", 2026, 3)).toStrictEqual([
      "2026-01-31",
      "2026-03-31",
      "2026-05-31",
      "2026-07-31",
      "2026-08-31",
      "2026-10-31",
      "2026-12-31",
    ]);
    const delivered = tileDueInstants(
      "0 3 31 * *",
      "2026-01-20T00:00:00.000Z",
      "2026-02-20T00:00:00.000Z"
    );
    expect(dates(delivered)).toStrictEqual(["2026-01-31"]);
  });

  it("never fires a February 30 expression, in a leap year or a common one", () => {
    for (const year of [2027, 2028, 2100]) {
      expect(matchingDays("0 3 30 2 *", year, 3)).toStrictEqual([]);
    }
    expect(
      tileDueInstants(
        "0 3 30 2 *",
        "2028-02-01T00:00:00.000Z",
        "2028-03-02T00:00:00.000Z"
      )
    ).toStrictEqual([]);
  });

  it("delivers every minute of a month exactly once across both its seams", () => {
    for (const [year, days] of [
      [2028, 29],
      [2027, 28],
    ] as const) {
      const minutes = tileDueInstants(
        "* * * * *",
        `${year}-02-01T00:00:00.000Z`,
        `${year}-03-01T00:00:00.000Z`
      );
      expect(minutes).toHaveLength(days * 1_440);
      const keys = new Set(
        minutes.map((instant) => wallClockMinuteKey(instant, ZONE))
      );
      expect(keys.size).toBe(minutes.length);
      expect(minutes[0]?.toISOString()).toBe(`${year}-02-01T00:01:00.000Z`);
      expect(minutes.at(-1)?.toISOString()).toBe(`${year}-03-01T00:00:00.000Z`);
    }
  });

  it("counts a month rollover as an ordinary gap, not a missed year", () => {
    const result = readCronCursor(
      [{ expr: "0 3 * * *", timeZone: ZONE }],
      cursorAt(Date.parse("2026-01-30T03:00:00.000Z")),
      new Date("2026-02-02T03:00:00.000Z")
    );
    expect(
      result.elements.map((element) =>
        new Date(element.occurredAt).toISOString()
      )
    ).toStrictEqual(["2026-02-02T03:00:00.000Z"]);
    expect(result.skipped).toBe(2);
    expect(result.gapReason).toBe("scheduler_gap");
  });
});

describe("year boundaries", () => {
  beforeEach(() => {
    useFakeClock("2026-12-31T00:00:00.000Z");
  });

  it("delivers the last minute of the year and the first minute of the next, once each", () => {
    const lastMinute = tileDueInstants(
      "59 23 31 12 *",
      "2026-12-25T00:00:00.000Z",
      "2027-01-05T00:00:00.000Z"
    );
    const firstMinute = tileDueInstants(
      "0 0 1 1 *",
      "2026-12-25T00:00:00.000Z",
      "2027-01-05T00:00:00.000Z"
    );
    expect(lastMinute.map((day) => day.toISOString())).toStrictEqual([
      "2026-12-31T23:59:00.000Z",
    ]);
    expect(firstMinute.map((day) => day.toISOString())).toStrictEqual([
      "2027-01-01T00:00:00.000Z",
    ]);
    expect(
      (firstMinute[0] as Date).getTime() - (lastMinute[0] as Date).getTime()
    ).toBe(MINUTE);
  });

  it("keeps the weekday sequence unbroken across the year seam", () => {
    const weekdays = [
      "2026-12-30T12:00:00.000Z",
      "2026-12-31T12:00:00.000Z",
      "2027-01-01T12:00:00.000Z",
      "2027-01-02T12:00:00.000Z",
    ].map((iso) => wallClockFields(new Date(iso), ZONE).weekday);
    expect(weekdays).toStrictEqual([3, 4, 5, 6]);
    expect(
      cronMatches("0 12 * * 5", new Date("2027-01-01T12:00:00.000Z"), ZONE)
    ).toBe(true);
    expect(
      cronMatches("0 12 * * 4", new Date("2027-01-01T12:00:00.000Z"), ZONE)
    ).toBe(false);
  });

  it("fires one New Year per zone even when the extreme offsets are 26 hours apart", () => {
    const east = tileDueInstants(
      "0 0 1 1 *",
      "2026-12-25T00:00:00.000Z",
      "2027-01-05T00:00:00.000Z",
      "Pacific/Kiritimati"
    );
    const west = tileDueInstants(
      "0 0 1 1 *",
      "2026-12-25T00:00:00.000Z",
      "2027-01-05T00:00:00.000Z",
      "Etc/GMT+12"
    );
    expect(east.map((day) => day.toISOString())).toStrictEqual([
      "2026-12-31T10:00:00.000Z",
    ]);
    expect(west.map((day) => day.toISOString())).toStrictEqual([
      "2027-01-01T12:00:00.000Z",
    ]);
    expect((west[0] as Date).getTime() - (east[0] as Date).getTime()).toBe(
      26 * 60 * MINUTE
    );
  });

  it("reports a year-spanning outage as a bounded gap, never as a phantom run", () => {
    const to = Date.parse("2027-01-05T03:00:00.000Z");
    const result = readCronCursor(
      [{ expr: "0 3 * * *", timeZone: ZONE }],
      cursorAt(Date.parse("2026-11-05T03:00:00.000Z")),
      new Date(to)
    );
    const trueMissed = 60; // daily 03:00 fires between Nov 5 and Jan 5.
    expect(
      result.elements.map((element) =>
        new Date(element.occurredAt).toISOString()
      )
    ).toStrictEqual(["2027-01-05T03:00:00.000Z"]);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.skipped).toBeLessThanOrEqual(trueMissed);
    expect(result.gapReason).toBe("scheduler_gap");
  });
});

describe("the leap second", () => {
  beforeEach(() => {
    useFakeClock("2016-12-31T00:00:00.000Z");
  });

  const LEAP_MINUTE = "2016-12-31T23:59:00.000Z";
  const NEXT_MINUTE = "2017-01-01T00:00:00.000Z";

  it("gives the leap minute one absolute instant and one wall-clock key", () => {
    expect(Number.isNaN(Date.parse("2016-12-31T23:59:60Z"))).toBe(true);
    expect(wallClockMinuteKey(new Date(LEAP_MINUTE), ZONE)).not.toBe(
      wallClockMinuteKey(new Date(NEXT_MINUTE), ZONE)
    );
  });

  it("delivers every minute across the insertion exactly once", () => {
    const from = Date.parse(LEAP_MINUTE) - 60 * MINUTE;
    const to = Date.parse(LEAP_MINUTE) + 60 * MINUTE;
    const minutes = dueInstants(
      [{ expr: "* * * * *", timeZone: ZONE }],
      new Date(from),
      new Date(to)
    );
    expect(minutes).toHaveLength(120);
    expect(
      new Set(minutes.map((instant) => wallClockMinuteKey(instant, ZONE))).size
    ).toBe(120);
    expect(minutes.map((instant) => instant.toISOString())).toContain(
      LEAP_MINUTE
    );
    expect(minutes.map((instant) => instant.toISOString())).toContain(
      NEXT_MINUTE
    );
  });

  it("fires the leap minute once when a smeared clock re-reads it", () => {
    let cursor: AutomationTriggerCursor | undefined = cursorAt(
      Date.parse(LEAP_MINUTE) - MINUTE
    );
    const fired: number[] = [];
    const wakeups = [
      Date.parse(LEAP_MINUTE) + 10_000,
      Date.parse(LEAP_MINUTE) + 30_000,
      Date.parse(LEAP_MINUTE) + 59_000,
      Date.parse(NEXT_MINUTE) + 1_000,
      Date.parse(NEXT_MINUTE) + 61_000,
    ];
    for (const wakeup of wakeups) {
      const result = readCronCursor(
        [{ expr: "* * * * *", timeZone: ZONE }],
        cursor,
        new Date(wakeup)
      );
      for (const element of result.elements) fired.push(element.occurredAt);
      if (result.positionJson !== undefined) {
        cursor = {
          ...cursorAt(wakeup),
          positionJson: result.positionJson,
        };
      }
    }

    expect(
      fired.map((instant) => new Date(instant).toISOString())
    ).toStrictEqual([LEAP_MINUTE, NEXT_MINUTE, "2017-01-01T00:01:00.000Z"]);
    expect(new Set(fired).size).toBe(fired.length);
  });

  it("does not let the leap second push the last-minute-of-year schedule into the next year", () => {
    const delivered = tileDueInstants(
      "59 23 31 12 *",
      "2016-12-25T00:00:00.000Z",
      "2017-01-05T00:00:00.000Z"
    );
    expect(delivered.map((instant) => instant.toISOString())).toStrictEqual([
      LEAP_MINUTE,
    ]);
    expect(wallClockFields(delivered[0] as Date, ZONE).year).toBe(2016);
  });
});
