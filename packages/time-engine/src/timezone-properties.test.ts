/**
 * Civil-time laws for `timezone.ts` (#656 Layer 3 mutation seed).
 *
 * `recurrence.ts` is only correct if the wall-clock primitives underneath it
 * are. Before this file nothing imported `timezone.ts` directly — every one of
 * its branches was reached transitively by a handful of table-driven
 * recurrence cases, which is execution, not detection: swapping `<` for `<=`
 * in the overlap sort, dropping the day-clamp in `addWallMonths`, or padding
 * the year to 2 digits all still produced the same six asserted strings.
 *
 * Each test below states a law the module must obey for ALL inputs, never a
 * literal the current implementation happens to emit.
 */
import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  addWallDays,
  addWallMonths,
  isIanaTimeZone,
  parseWallIso,
  resolveWallTime,
  wallEpoch,
  wallIso,
  wallWeekday,
  zonedParts,
} from "./timezone.js";
import type { WallTime } from "./timezone.js";

const wallTime = fc
  .record({
    year: fc.integer({ min: 1600, max: 2400 }),
    month: fc.integer({ min: 1, max: 12 }),
    day: fc.integer({ min: 1, max: 28 }),
    hour: fc.integer({ min: 0, max: 23 }),
    minute: fc.integer({ min: 0, max: 59 }),
    second: fc.integer({ min: 0, max: 59 }),
    millisecond: fc.constant(0),
  })
  // Spread into a plain object — fast-check records carry a null prototype,
  // which `toStrictEqual` treats as a difference.
  .map((w): WallTime => ({ ...w }));

/** Zones with distinct DST behaviour: none, southern, northern, half-hour. */
const ZONES = [
  "Etc/UTC",
  "Asia/Kolkata",
  "America/New_York",
  "Europe/Berlin",
  "Australia/Sydney",
  "America/Sao_Paulo",
] as const;

describe("wall-clock algebra", () => {
  test("wallIso and parseWallIso are inverses on every civil field", () => {
    fc.assert(
      fc.property(wallTime, (wall) => {
        const parsed = parseWallIso(wallIso(wall));
        // Round-trip must preserve EVERY field — a dropped pad or a swapped
        // month/day would still produce a parseable string.
        expect(parsed).toStrictEqual(wall);
      }),
      { numRuns: 200, seed: 65601 }
    );
  });

  test("the date-only form is exactly the date prefix of the full form", () => {
    fc.assert(
      fc.property(wallTime, (wall) => {
        const date = wallIso(wall, false);
        expect(wallIso(wall)).toBe(`${date}T${wallIso(wall).slice(11)}`);
        expect(date).toHaveLength(10);
        expect(date).toBe(wallIso(wall).slice(0, 10));
      }),
      { numRuns: 100, seed: 65602 }
    );
  });

  test("years below 1000 keep four digits so ISO strings stay sortable", () => {
    // String comparison is how `applyRecurrenceExceptions` orders future-scope
    // exceptions; a 3-digit year would sort after every 4-digit one.
    const wall = parseWallIso("0999-01-02T03:04:05");
    expect(wall).not.toBeNull();
    expect(wallIso(wall as WallTime, false)).toBe("0999-01-02");
    expect(wallIso(wall as WallTime, false) < "1000-01-01").toBe(true);
  });

  test("parseWallIso rejects a calendar date that does not exist", () => {
    // Date.UTC silently rolls 2026-02-30 into March; the round-trip guard is
    // the only thing that turns that into a rejection.
    expect(parseWallIso("2026-02-30")).toBeNull();
    expect(parseWallIso("2026-13-01")).toBeNull();
    expect(parseWallIso("2025-02-29")).toBeNull();
    expect(parseWallIso("2024-02-29")).not.toBeNull(); // real leap day
    expect(parseWallIso("not-a-date")).toBeNull();
  });

  test("adding then subtracting the same number of days is the identity", () => {
    fc.assert(
      fc.property(wallTime, fc.integer({ min: -400, max: 400 }), (wall, n) => {
        expect(addWallDays(addWallDays(wall, n), -n)).toStrictEqual(wall);
      }),
      { numRuns: 200, seed: 65603 }
    );
  });

  test("adding n days moves the epoch by exactly n days and the weekday by n mod 7", () => {
    fc.assert(
      fc.property(wallTime, fc.integer({ min: -60, max: 60 }), (wall, n) => {
        const moved = addWallDays(wall, n);
        expect(wallEpoch(moved) - wallEpoch(wall)).toBe(n * 86_400_000);
        expect(wallWeekday(moved)).toBe(
          (((wallWeekday(wall) + n) % 7) + 7) % 7
        );
      }),
      { numRuns: 200, seed: 65604 }
    );
  });

  test("adding n months lands on month n later and clamps to a real day", () => {
    fc.assert(
      fc.property(
        wallTime,
        fc.integer({ min: 1, max: 31 }),
        fc.integer({ min: -36, max: 36 }),
        (wall, dayOfMonth, n) => {
          const lastDay = new Date(
            Date.UTC(wall.year, wall.month, 0)
          ).getUTCDate();
          const anchor: WallTime = {
            ...wall,
            day: Math.min(dayOfMonth, lastDay),
          };
          const moved = addWallMonths(anchor, n);
          const months =
            (moved.year - anchor.year) * 12 + (moved.month - anchor.month);
          expect(months).toBe(n);
          // The day never overflows into the next month, and never grows.
          const movedLast = new Date(
            Date.UTC(moved.year, moved.month, 0)
          ).getUTCDate();
          expect(moved.day).toBeLessThanOrEqual(movedLast);
          expect(moved.day).toBe(Math.min(anchor.day, movedLast));
          // Time of day is untouched by calendar arithmetic.
          expect(moved.hour).toBe(anchor.hour);
          expect(moved.minute).toBe(anchor.minute);
        }
      ),
      { numRuns: 200, seed: 65605 }
    );
  });

  test("Jan 31 + 1 month clamps to the end of February, not March 3", () => {
    expect(
      addWallMonths(parseWallIso("2026-01-31") as WallTime, 1)
    ).toMatchObject({ year: 2026, month: 2, day: 28 });
    expect(
      addWallMonths(parseWallIso("2024-01-31") as WallTime, 1)
    ).toMatchObject({ year: 2024, month: 2, day: 29 });
  });
});

describe("zone resolution", () => {
  test("isIanaTimeZone accepts real zones and rejects everything else", () => {
    for (const zone of ZONES) expect(isIanaTimeZone(zone)).toBe(true);
    for (const bad of ["", "   ", "Mars/Olympus", "GMT+5", "not a zone"]) {
      expect(isIanaTimeZone(bad), bad).toBe(false);
    }
  });

  test("resolveWallTime inverts zonedParts for every instant outside a gap", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.constantFrom(...ZONES),
        (seconds, zone) => {
          const instant = seconds * 1000;
          const wall = zonedParts(instant, zone);
          const resolved = resolveWallTime(wall, zone);
          expect(resolved).not.toBeNull();
          // The resolved instant must show the SAME wall clock in that zone.
          // (During a fall-back overlap it is the earlier of the two, which
          // still reads back identically.)
          expect(
            zonedParts(
              Date.parse((resolved as { instant: string }).instant),
              zone
            )
          ).toStrictEqual(wall);
        }
      ),
      { numRuns: 200, seed: 65606 }
    );
  });

  test("an overlap resolves to the EARLIER of the two instants", () => {
    // 2026-11-01 01:30 America/New_York happens twice (EDT then EST).
    const wall = parseWallIso("2026-11-01T01:30:00") as WallTime;
    const resolved = resolveWallTime(wall, "America/New_York");
    expect(resolved?.overlap).toBe(true);
    const earlier = Date.parse(resolved?.instant as string);
    // EDT is UTC-4, EST is UTC-5 — the earlier instant is the UTC-4 one.
    expect(new Date(earlier).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(earlier).toBeLessThan(Date.parse("2026-11-01T06:30:00.000Z"));
  });

  test("a spring-forward gap has no instant at all", () => {
    // 2026-03-08 02:30 America/New_York never occurs.
    const wall = parseWallIso("2026-03-08T02:30:00") as WallTime;
    expect(resolveWallTime(wall, "America/New_York")).toBeNull();
    // The same civil time one day later does occur.
    expect(
      resolveWallTime(
        parseWallIso("2026-03-09T02:30:00") as WallTime,
        "America/New_York"
      )
    ).not.toBeNull();
  });

  test("resolveWallTime refuses an unknown zone rather than guessing UTC", () => {
    const wall = parseWallIso("2026-07-01T09:00:00") as WallTime;
    expect(resolveWallTime(wall, "Mars/Olympus")).toBeNull();
    expect(resolveWallTime(wall, "")).toBeNull();
  });

  test("a non-overlapping instant is never flagged as an overlap", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 28 }), (day) => {
        // July has no DST transition in any of the sampled zones.
        const wall = parseWallIso(
          `2026-07-${String(day).padStart(2, "0")}T09:00:00`
        ) as WallTime;
        for (const zone of ZONES) {
          expect(resolveWallTime(wall, zone)?.overlap, zone).toBe(false);
        }
      }),
      { numRuns: 28, seed: 65607 }
    );
  });
});
