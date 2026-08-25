/*
 * CALENDAR-BOUNDARY injection against the cron matcher and cursor (#842,
 * W3.3).
 *
 * `time-zoo-calendar.test.ts` (#839) owns the two irregularities that arrive
 * once every few years — February 29 and the 53-week ISO year. This file owns
 * the boundaries that arrive every month and every year, plus the one the
 * civil clock inserts and Unix time refuses to represent: the leap second.
 *
 * They are worth their own file for the same reason the leap day was: the
 * failure is an off-by-one that only exists on the seam. A month rollover that
 * loses a minute loses it twelve times a year, invisibly, because every other
 * minute of the month is fine. A `31` expression that is silently clamped into
 * short months fires an automation five times it should not. And a leap second
 * is a wall clock that shows 23:59:60 while `Date` shows 23:59:59 twice or
 * 00:00:00 early, depending on how the host smears it — either way, a minute
 * boundary crossed twice.
 *
 * Same three invariants as the clock-adversity file, and the same reason they
 * are stated per case: NO DOUBLE FIRE, NO SILENT SKIP, NO DRIFT.
 *
 * Every assertion is stated in an explicit IANA zone (docs/cron-timezone.md
 * § "Matching"), so none of it can turn on the runner's own TZ.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { AutomationTriggerCursor } from "@centraid/server/engine";
import { useFakeClock } from "@centraid/test-kit/fake-clock";

import { wallClockFields, wallClockMinuteKey } from "../cron-timezone.js";
import { dueInstants, readCronCursor } from "./cron-cursor.js";
import { cronMatches } from "./cron-match.js";

const MINUTE = 60_000;
const DAY = 1_440 * MINUTE;

/** The zone most assertions below are stated in. */
const ZONE = "Etc/UTC";

/**
 * `dueInstants` caps one call at 31 days, so any claim about a longer span is
 * asserted over a TILING of half-open windows. The tiling is not incidental:
 * a `(from, to]` boundary that dropped or duplicated an instant would change
 * every count in this file, which is exactly the month-seam defect being
 * hunted.
 */
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

/** `YYYY-MM-DD` of every delivered instant, for readable failure output. */
function dates(instants: readonly Date[]): string[] {
  return instants.map((instant) => instant.toISOString().slice(0, 10));
}

/**
 * Every civil day of `year` on which `expr` matches at `hour`:00 in `ZONE`.
 *
 * One probe per day rather than one per minute. A day-of-month law is a claim
 * about which DAYS match, and asserting it over 525,600 minute probes would
 * pay a whole PR-lane minute to re-derive the same set.
 */
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
    // Vixie cron does not clamp: `31` means the 31st, and a month without one
    // simply has no matching day. The failure worth catching is a matcher that
    // clamps to the month end — it would fire this automation twelve times a
    // year, five of them on a date the member never asked for.
    //
    // The whole-year claim is asserted with the MATCHER, one probe per civil
    // day, because a year of minute-by-minute cursor scanning buys nothing
    // here and costs the PR lane a wall-clock minute. The delivery half is
    // asserted below over one real window that spans a long month and a short
    // one.
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
    // The unsatisfiable-forever case. `30 2` parses (both fields are in range)
    // and matches no instant that has ever existed or ever will, which is the
    // same shape as the DST gap: a wall clock with no absolute instant behind
    // it. A clamp here would invent February 29 — or worse, March 1.
    for (const year of [2027, 2028, 2100]) {
      expect(matchingDays("0 3 30 2 *", year, 3)).toStrictEqual([]);
    }
    // …and it is undeliverable, not merely unmatched, over a window that
    // contains the whole of a leap February.
    expect(
      tileDueInstants(
        "0 3 30 2 *",
        "2028-02-01T00:00:00.000Z",
        "2028-03-02T00:00:00.000Z"
      )
    ).toStrictEqual([]);
  });

  it("delivers every minute of a month exactly once across both its seams", () => {
    // The census that makes a lost or duplicated minute impossible to hide: a
    // minutely schedule over a whole month must produce exactly as many due
    // instants as the month has minutes, each with a distinct wall-clock key.
    // Run over February in a leap year and a common one, because those are the
    // two months whose length the arithmetic is most likely to hard-code.
    for (const [year, days] of [
      [2028, 29],
      [2027, 28],
    ] as const) {
      const minutes = tileDueInstants(
        "* * * * *",
        `${year}-02-01T00:00:00.000Z`,
        `${year}-03-01T00:00:00.000Z`
      );
      // The window is half-open, so it carries the month's minutes shifted by
      // one: (Feb 1 00:00, Mar 1 00:00] is `days * 1440` minutes.
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
    // A gateway down across the last minute of a month. The missed count is
    // what the member is shown, so the arithmetic that produces it must treat
    // 31 → 1 as one day like any other.
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
    // 01-31 and 02-01 were missed; 02-02 was delivered.
    expect(result.skipped).toBe(2);
    expect(result.gapReason).toBe("scheduler_gap");
  });
});

describe("year boundaries", () => {
  beforeEach(() => {
    useFakeClock("2026-12-31T00:00:00.000Z");
  });

  it("delivers the last minute of the year and the first minute of the next, once each", () => {
    // The two expressions that sit on the seam itself. Each must be delivered
    // exactly once, and they must be a minute apart — a year rollover that
    // re-anchored anything would show up as a duplicate or a gap right here.
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
    // 2026-12-31 is a Thursday, so 2027-01-01 is a Friday. A weekday
    // derivation that re-anchored on January 1 would slip every `* * * <dow>`
    // automation by a day for the whole next year — the largest, quietest
    // scheduling failure in this file.
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
    // The widest civil-time spread the world has: Pacific/Kiritimati (+14) and
    // Etc/GMT+12 (−12) celebrate the same wall-clock minute 26 hours apart.
    // Each schedule fires exactly once, on its own zone's midnight, and the two
    // absolute instants are distinct — a matcher that leaked one zone's offset
    // into the other would collapse or duplicate them.
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
    // A gateway restored from a backup taken before the New Year. The scan
    // horizon (31 days) is what bounds the count; the direction of the
    // degradation is the invariant — it may under-report, never over-report.
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

  /**
   * The most recent inserted leap second was 2016-12-31 23:59:60 UTC. POSIX
   * time has no representation for it: a host either repeats 23:59:59 or
   * smears the second across a window. Either way the minute boundary at
   * 00:00 is approached twice, which is the double-fire shape — and the same
   * shape as the DST fall-back, minus the zone.
   */
  const LEAP_MINUTE = "2016-12-31T23:59:00.000Z";
  const NEXT_MINUTE = "2017-01-01T00:00:00.000Z";

  it("gives the leap minute one absolute instant and one wall-clock key", () => {
    // The premise: `Date` cannot represent :60, so the extra second folds into
    // 23:59:59 and the minute keeps exactly one identity. Stated separately so
    // a failure below distinguishes "our model of the leap second is wrong"
    // from "cron is wrong".
    // ECMA-262 rejects a :60 second outright — the leap second has no
    // representation to collide with, which is WHY the minute keeps one
    // identity rather than two.
    expect(Number.isNaN(Date.parse("2016-12-31T23:59:60Z"))).toBe(true);
    expect(wallClockMinuteKey(new Date(LEAP_MINUTE), ZONE)).not.toBe(
      wallClockMinuteKey(new Date(NEXT_MINUTE), ZONE)
    );
  });

  it("delivers every minute across the insertion exactly once", () => {
    // The census, one hour either side of the insertion. 120 minutes in, 120
    // due instants out, all distinct: no minute repeated by a repeated
    // 23:59:59, none dropped by a host that jumped straight to 00:00:00.
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
    // A host applying a leap smear runs slow: successive wakeups can land in
    // the SAME wall minute, and a scheduler that answered "what matches now?"
    // instead of "what is due since my position?" would fire twice. The
    // committed position is what refuses it.
    let cursor: AutomationTriggerCursor | undefined = cursorAt(
      Date.parse(LEAP_MINUTE) - MINUTE
    );
    const fired: number[] = [];
    // Three wakeups inside the leap minute (a smear stretching it), then the
    // ordinary next two minutes.
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

    // NO DOUBLE FIRE: three wakeups inside 23:59 produced one delivery of it.
    expect(
      fired.map((instant) => new Date(instant).toISOString())
    ).toStrictEqual([LEAP_MINUTE, NEXT_MINUTE, "2017-01-01T00:01:00.000Z"]);
    expect(new Set(fired).size).toBe(fired.length);
  });

  it("does not let the leap second push the last-minute-of-year schedule into the next year", () => {
    // The combination case, and the reason this block lives beside the year
    // boundary: `59 23 31 12 *` sits on the exact minute the leap second is
    // inserted into. It must be delivered once, in 2016.
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
