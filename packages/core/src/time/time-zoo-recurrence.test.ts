/*
 * The RECURRENCE time zoo (issue #839, gap G12).
 *
 * `recurrence.test.ts` and `recurrence-properties.test.ts` state the civil-time
 * laws over ordinary calendars. This file states the same laws over the three
 * calendars that are not ordinary — the DST transition, the leap day, and the
 * ISO year with fifty-three weeks in it — across a zoo of adversarial zones
 * rather than one representative one.
 *
 * The doctrine being tested is shared with cron, and is stated once in
 * docs/cron-timezone.md:
 *
 *   § intro: "The shared DST policy is the cron policy below: a nonexistent
 *   wall time is skipped and an overlapping wall time occurs once at the
 *   earlier instant."
 *
 *   § "DST policy", Gap row     → SKIP.
 *   § "DST policy", Overlap row → ONCE.
 *
 * The zone table below is deliberately a duplicate of the one in
 * `packages/server/src/automation/fire/time-zoo-cron.test.ts`: `@centraid/core`
 * is the dependency-free contracts package and must not reach into a server
 * test helper, and a shared fixture would let one edit weaken both suites at
 * once. The two copies are checked against the runtime's own tzdata by the
 * tests that read them, so a drift shows up as a failure rather than as a
 * silent disagreement.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { seededRandom } from "@centraid/test-kit/random";

import { expandRecurrence } from "./recurrence.js";
import { resolveWallTime, zonedParts } from "./timezone.js";
import type { WallTime } from "./timezone.js";

/** A civil day plus the half-open wall band a transition breaks on it. */
type Band = {
  readonly transitionUtc: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** Half-open [from, to) minute-of-day range of the affected wall clock. */
  readonly fromMinute: number;
  readonly toMinute: number;
};

type ZooZone = {
  readonly zone: string;
  readonly why: string;
  readonly gap: Band;
  readonly overlap: Band;
};

const ZOO: readonly ZooZone[] = [
  {
    zone: "America/New_York",
    why: "the doctrine's pinned zone (docs/cron-timezone.md § 'DST policy')",
    gap: {
      transitionUtc: "2026-03-08T07:00:00.000Z",
      year: 2026,
      month: 3,
      day: 8,
      fromMinute: 120,
      toMinute: 180,
    },
    overlap: {
      transitionUtc: "2026-11-01T06:00:00.000Z",
      year: 2026,
      month: 11,
      day: 1,
      fromMinute: 60,
      toMinute: 120,
    },
  },
  {
    zone: "Europe/Dublin",
    why: "negative DST: the summer offset is the STANDARD one, so an is-DST flag reads backwards here",
    gap: {
      transitionUtc: "2026-03-29T01:00:00.000Z",
      year: 2026,
      month: 3,
      day: 29,
      fromMinute: 60,
      toMinute: 120,
    },
    overlap: {
      transitionUtc: "2026-10-25T01:00:00.000Z",
      year: 2026,
      month: 10,
      day: 25,
      fromMinute: 60,
      toMinute: 120,
    },
  },
  {
    zone: "Australia/Lord_Howe",
    why: "a thirty-minute shift on a :30 base offset — the band is half an hour wide, southern hemisphere",
    gap: {
      transitionUtc: "2026-10-03T15:30:00.000Z",
      year: 2026,
      month: 10,
      day: 4,
      fromMinute: 120,
      toMinute: 150,
    },
    overlap: {
      transitionUtc: "2026-04-04T15:00:00.000Z",
      year: 2026,
      month: 4,
      day: 5,
      fromMinute: 90,
      toMinute: 120,
    },
  },
];

/** The fixed-offset control: it must never produce a gap or an overlap. */
const FIXED_ZONE = "Asia/Kolkata";

const ZOO_SEED = 839_012;
const SAMPLES_PER_BAND = 3;

function sampleMinutes(band: Band): number[] {
  const rng = seededRandom(ZOO_SEED);
  const width = band.toMinute - band.fromMinute;
  const drawn = new Set<number>([band.fromMinute, band.toMinute - 1]);
  let guard = 0;
  while (drawn.size < Math.min(SAMPLES_PER_BAND, width) && guard < 100) {
    guard += 1;
    drawn.add(band.fromMinute + rng.int(0, width - 1));
  }
  return [...drawn].sort((left, right) => left - right);
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

/** Civil day `dayOffset` days from the band's date, as `YYYY-MM-DD`. */
function civilDay(band: Band, dayOffset: number): string {
  const shifted = new Date(
    Date.UTC(band.year, band.month - 1, band.day + dayOffset)
  );
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** The `wallStart` a zoned instance on that civil day and minute must carry. */
function wallStartOn(
  band: Band,
  dayOffset: number,
  minuteOfDay: number
): string {
  const hour = pad(Math.floor(minuteOfDay / 60));
  const minute = pad(minuteOfDay % 60);
  return `${civilDay(band, dayOffset)}T${hour}:${minute}:00`;
}

/**
 * Every absolute instant within ±20h of the naive UTC reading whose wall clock
 * in `zone` is exactly the requested civil minute. Built from `zonedParts`
 * (Intl) rather than from `resolveWallTime`, so the fixtures the resolver's own
 * laws are asserted against are not produced by the resolver.
 */
function instantsWithWall(
  zone: string,
  isoDay: string,
  minuteOfDay: number
): Date[] {
  const [year, month, day] = isoDay.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const out: Date[] = [];
  for (let offset = -20 * 60; offset <= 20 * 60; offset += 1) {
    const candidate = new Date(naive + offset * 60_000);
    const parts = zonedParts(candidate, zone);
    const hit =
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === hour &&
      parts.minute === minute &&
      parts.second === 0;
    if (hit) out.push(candidate);
  }
  return out;
}

function wallOf(isoDay: string, minuteOfDay: number): WallTime {
  const [year, month, day] = isoDay.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return {
    year,
    month,
    day,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
    millisecond: 0,
  };
}

/** A daily zoned series anchored two civil days before the band. */
function dailyAcrossBand(
  zone: string,
  band: Band,
  minuteOfDay: number
): { starts: string[]; walls: string[]; overlaps: string[] } {
  const anchor = instantsWithWall(zone, civilDay(band, -2), minuteOfDay)[0];
  if (!anchor) throw new Error(`no anchor instant for ${zone} ${minuteOfDay}`);
  // The exclusive bound is the INSTANT of the civil day after the last one the
  // window wants, not `anchor + 5 days`: an offset change moves the absolute
  // length of those five civil days, and a millisecond bound would then let a
  // sixth day in on one side of the transition and not the other.
  const bound = instantsWithWall(zone, civilDay(band, 3), minuteOfDay)[0];
  if (!bound) throw new Error(`no bounding instant for ${zone} ${minuteOfDay}`);
  const instances = expandRecurrence({
    rrule: "FREQ=DAILY",
    start: anchor.toISOString(),
    rangeFrom: new Date(anchor.getTime() - 60_000).toISOString(),
    rangeTo: bound.toISOString(),
    timeZone: zone,
    semantics: "zoned",
    maxInstances: 20,
  });
  return {
    starts: instances.map((instance) => instance.start),
    walls: instances.map((instance) => instance.wallStart),
    overlaps: instances
      .filter((instance) => instance.overlap)
      .map((instance) => instance.wallStart),
  };
}

const ZOO_ROWS = ZOO.map((entry) => [entry.zone, entry] as const);

describe("recurrence DST zoo", () => {
  beforeEach(() => {
    // Every law here is a pure function of its inputs; the pinned clock keeps
    // it that way, so a `Date.now()` creeping into the expansion path fails on
    // every run rather than on one day a year.
    useFakeClock("2026-06-15T12:00:00.000Z");
  });

  describe("gap law: a nonexistent wall time is skipped", () => {
    it.each(ZOO_ROWS)(
      "%s resolves every sampled minute of its spring-forward band to null",
      (zone, entry) => {
        // docs/cron-timezone.md § intro: "a nonexistent wall time is skipped".
        // `resolveWallTime` expresses "skipped" as `null` — there is no
        // instant to fall back to, and inventing the shifted one is exactly
        // the defect this law forbids.
        const minutes = sampleMinutes(entry.gap);
        const resolved = minutes.map((minute) =>
          resolveWallTime(wallOf(civilDay(entry.gap, 0), minute), zone)
        );
        expect(resolved).toStrictEqual(minutes.map(() => null));
        // Cross-check against Intl directly: no absolute instant carries that
        // wall clock, so `null` is the truth and not merely the convention.
        const witnessCounts = minutes.map(
          (minute) =>
            instantsWithWall(zone, civilDay(entry.gap, 0), minute).length
        );
        expect(witnessCounts).toStrictEqual(minutes.map(() => 0));
      }
    );

    it.each(ZOO_ROWS)(
      "%s drops exactly the transition day from a daily series and keeps the wall clock either side",
      (zone, entry) => {
        const minute = sampleMinutes(entry.gap)[0] as number;
        const series = dailyAcrossBand(zone, entry.gap, minute);
        // The civil day itself is absent; every other day of the window keeps
        // the SAME wall clock through the offset change, which is what makes
        // this civil-time arithmetic rather than a fixed millisecond step.
        expect(series.walls).toStrictEqual([
          wallStartOn(entry.gap, -2, minute),
          wallStartOn(entry.gap, -1, minute),
          wallStartOn(entry.gap, 1, minute),
          wallStartOn(entry.gap, 2, minute),
        ]);
        expect(series.overlaps).toStrictEqual([]);
        // The absolute step across the skipped day is NOT 48h: the offset
        // moved, which is the whole reason a UTC loop gets this wrong.
        const beforeGap = series.starts[1] as string;
        const afterGap = series.starts[2] as string;
        expect(Date.parse(afterGap) - Date.parse(beforeGap)).not.toBe(
          2 * 86_400_000
        );
      }
    );
  });

  describe("overlap law: a repeated wall time occurs once, at the earlier instant", () => {
    it.each(ZOO_ROWS)(
      "%s resolves every sampled minute of its fall-back band to the EARLIER of its two instants",
      (zone, entry) => {
        // docs/cron-timezone.md § intro: "an overlapping wall time occurs once
        // at the earlier instant." Earlier, not later: the member set an alarm
        // for 01:30 and the first 01:30 is the one they meant.
        const minutes = sampleMinutes(entry.overlap);
        const witnessed = minutes.map((minute) =>
          instantsWithWall(zone, civilDay(entry.overlap, 0), minute)
        );
        expect(witnessed.map((list) => list.length)).toStrictEqual(
          minutes.map(() => 2)
        );
        const resolved = minutes.map((minute) =>
          resolveWallTime(wallOf(civilDay(entry.overlap, 0), minute), zone)
        );
        expect(resolved).toStrictEqual(
          witnessed.map((list) => ({
            instant: (list[0] as Date).toISOString(),
            overlap: true,
          }))
        );
      }
    );

    it.each(ZOO_ROWS)(
      "%s emits the transition day once, flagged, in a daily series",
      (zone, entry) => {
        const minute = sampleMinutes(entry.overlap)[0] as number;
        const series = dailyAcrossBand(zone, entry.overlap, minute);
        expect(series.walls).toStrictEqual([
          wallStartOn(entry.overlap, -2, minute),
          wallStartOn(entry.overlap, -1, minute),
          wallStartOn(entry.overlap, 0, minute),
          wallStartOn(entry.overlap, 1, minute),
          wallStartOn(entry.overlap, 2, minute),
        ]);
        // Only the transition day is ambiguous, and it says so — the flag is
        // what lets a surface explain the repeat instead of hiding it.
        expect(series.overlaps).toStrictEqual([
          wallStartOn(entry.overlap, 0, minute),
        ]);
        const earlier = instantsWithWall(
          zone,
          civilDay(entry.overlap, 0),
          minute
        )[0] as Date;
        expect(series.starts[2]).toBe(earlier.toISOString());
      }
    );
  });

  describe("fixed-offset control", () => {
    it("Asia/Kolkata resolves every sampled civil minute of 2026 exactly once", () => {
      // The control that keeps the two laws above about TRANSITIONS: a zone
      // that never shifts must produce neither a null nor an overlap flag,
      // whatever minute is drawn.
      const rng = seededRandom(ZOO_SEED);
      const probes = Array.from({ length: 10 }, () => ({
        day: `2026-${pad(rng.int(1, 12))}-${pad(rng.int(1, 28))}`,
        minuteOfDay: rng.int(0, 1439),
      }));
      const witnessCounts = probes.map(
        (probe) =>
          instantsWithWall(FIXED_ZONE, probe.day, probe.minuteOfDay).length
      );
      expect(witnessCounts).toStrictEqual(probes.map(() => 1));
      const flags = probes.map(
        (probe) =>
          resolveWallTime(wallOf(probe.day, probe.minuteOfDay), FIXED_ZONE)
            ?.overlap
      );
      expect(flags).toStrictEqual(probes.map(() => false));
    });
  });
});

describe("recurrence across the leap day", () => {
  beforeEach(() => {
    useFakeClock("2028-01-01T00:00:00.000Z");
  });

  it("keeps a February 29 yearly series anchored on the 29th, clamping only in common years", () => {
    // The anchor is never re-based on the clamped value: a series that drifted
    // to the 28th after 2029 would silently stop being a leap-day series.
    const instances = expandRecurrence({
      rrule: "FREQ=YEARLY",
      start: "2028-02-29T12:00:00.000Z",
      rangeFrom: "2028-01-01T00:00:00.000Z",
      rangeTo: "2034-01-01T00:00:00.000Z",
      timeZone: "Etc/UTC",
      semantics: "zoned",
      maxInstances: 10,
    });
    expect(instances.map((instance) => instance.wallStart)).toStrictEqual([
      "2028-02-29T12:00:00",
      "2029-02-28T12:00:00",
      "2030-02-28T12:00:00",
      "2031-02-28T12:00:00",
      "2032-02-29T12:00:00",
      "2033-02-28T12:00:00",
    ]);
  });

  it("clamps a month-end monthly series into February, leap year included", () => {
    // The 31st does not exist in every month; the series lands on the last day
    // that does, and February 2028 supplies the 29th rather than the 28th.
    const instances = expandRecurrence({
      rrule: "FREQ=MONTHLY",
      start: "2028-01-31T12:00:00.000Z",
      rangeFrom: "2028-01-01T00:00:00.000Z",
      rangeTo: "2028-07-01T00:00:00.000Z",
      timeZone: "Etc/UTC",
      semantics: "zoned",
      maxInstances: 10,
    });
    expect(instances.map((instance) => instance.wallStart)).toStrictEqual([
      "2028-01-31T12:00:00",
      "2028-02-29T12:00:00",
      "2028-03-31T12:00:00",
      "2028-04-30T12:00:00",
      "2028-05-31T12:00:00",
      "2028-06-30T12:00:00",
    ]);
  });

  it("counts the leap day as a day in a daily series", () => {
    // A daily series must gain a day in February of a leap year. The naive
    // failure — 28 days always — shifts every later occurrence by one.
    const instances = expandRecurrence({
      rrule: "FREQ=DAILY",
      start: "2028-02-27T12:00:00.000Z",
      rangeFrom: "2028-02-27T00:00:00.000Z",
      rangeTo: "2028-03-02T00:00:00.000Z",
      timeZone: "Etc/UTC",
      semantics: "zoned",
      maxInstances: 10,
    });
    expect(instances.map((instance) => instance.wallStart)).toStrictEqual([
      "2028-02-27T12:00:00",
      "2028-02-28T12:00:00",
      "2028-02-29T12:00:00",
      "2028-03-01T12:00:00",
    ]);
  });

  it("honours the Gregorian century rule when clamping February", () => {
    // 2100 is divisible by 4 and is NOT a leap year; 2000 is. A `% 4` shortcut
    // in the clamp would put a series on 2100-02-29.
    const instances = expandRecurrence({
      rrule: "FREQ=YEARLY;INTERVAL=100",
      start: "2000-02-29T12:00:00.000Z",
      rangeFrom: "2000-01-01T00:00:00.000Z",
      rangeTo: "2201-01-01T00:00:00.000Z",
      timeZone: "Etc/UTC",
      semantics: "zoned",
      maxInstances: 5,
    });
    expect(instances.map((instance) => instance.wallStart)).toStrictEqual([
      "2000-02-29T12:00:00",
      "2100-02-28T12:00:00",
      "2200-02-28T12:00:00",
    ]);
  });
});

describe("recurrence across an ISO week-53 year", () => {
  beforeEach(() => {
    useFakeClock("2026-06-15T12:00:00.000Z");
  });

  it("expands 53 Mondays over ISO year 2026", () => {
    // ISO year 2026 begins Monday 2025-12-29 and ends Sunday 2027-01-03; it is
    // a 53-week year because 2026-01-01 is a Thursday. A weekly series that
    // assumed 52 would drop a member-visible week.
    const instances = expandRecurrence({
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      start: "2025-12-29T09:00:00.000Z",
      rangeFrom: "2025-12-29T00:00:00.000Z",
      rangeTo: "2026-12-29T00:00:00.000Z",
      timeZone: "Etc/UTC",
      semantics: "zoned",
      maxInstances: 100,
    });

    expect(instances).toHaveLength(53);
    expect(instances[0]?.wallStart).toBe("2025-12-29T09:00:00");
    expect(instances.at(-1)?.wallStart).toBe("2026-12-28T09:00:00");
    const steps = instances
      .slice(1)
      .map(
        (instance, index) =>
          Date.parse(instance.start) -
          Date.parse((instances[index] as { start: string }).start)
      );
    expect(new Set(steps)).toStrictEqual(new Set([7 * 86_400_000]));
  });

  it("carries the 53rd week across the ISO year boundary without a re-anchor", () => {
    // The boundary itself. A series that re-derived its anchor from the
    // calendar year would emit a 6- or 8-day step exactly here.
    const instances = expandRecurrence({
      rrule: "FREQ=WEEKLY;BYDAY=MO",
      start: "2026-12-14T09:00:00.000Z",
      rangeFrom: "2026-12-14T00:00:00.000Z",
      rangeTo: "2027-01-12T00:00:00.000Z",
      timeZone: "Etc/UTC",
      semantics: "zoned",
      maxInstances: 20,
    });
    expect(instances.map((instance) => instance.wallStart)).toStrictEqual([
      "2026-12-14T09:00:00",
      "2026-12-21T09:00:00",
      "2026-12-28T09:00:00",
      "2027-01-04T09:00:00",
      "2027-01-11T09:00:00",
    ]);
  });
});
