import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import { collapseMissedOccurrences } from "./recurrence-collapse.js";
import { describeRecurrence } from "./recurrence-summary.js";
import {
  applyRecurrenceExceptions,
  expandRecurrence,
  nextOccurrence,
  shiftTemporal,
} from "./recurrence.js";

const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

function expandAllDay(rrule: string, start: string, maxInstances = 40) {
  return expandRecurrence({
    rrule,
    start,
    rangeFrom: start,
    rangeTo: "2100-01-01",
    semantics: "all-day",
    maxInstances,
  });
}

describe("occurrence lifecycle laws", () => {
  test("nextOccurrence is strictly after `after`, never equal to it", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 23 }), (hour) => {
        const after = `2026-07-05T${String(hour).padStart(2, "0")}:00:00.000Z`;
        const next = nextOccurrence({
          rrule: "FREQ=DAILY",
          scheduledStart: "2026-07-01T09:00:00.000Z",
          after,
          timeZone: "Etc/UTC",
        });
        expect(next).not.toBeNull();
        expect(Date.parse(next as string)).toBeGreaterThan(Date.parse(after));
      }),
      { numRuns: 24, seed: 65630 }
    );
  });

  test("a completion anchor re-bases the cadence on the completion time", () => {
    const scheduled = nextOccurrence({
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-07-01T09:00:00.000Z",
      after: "2026-07-05T12:00:00.000Z",
      timeZone: "Etc/UTC",
    });
    const completion = nextOccurrence({
      rrule: "FREQ=DAILY",
      scheduledStart: "2026-07-01T09:00:00.000Z",
      after: "2026-07-05T12:00:00.000Z",
      timeZone: "Etc/UTC",
      anchor: "completion",
    });
    expect(scheduled).toBe("2026-07-06T09:00:00.000Z");
    expect(completion).toBe("2026-07-06T12:00:00.000Z");
  });

  test("an unusable rule or `after` yields null instead of a guess", () => {
    expect(
      nextOccurrence({
        rrule: "FREQ=DAILY",
        scheduledStart: "2026-07-01T09:00:00.000Z",
        after: "not-a-date",
      })
    ).toBeNull();
    expect(
      nextOccurrence({
        rrule: "FREQ=HOURLY",
        scheduledStart: "2026-07-01T09:00:00.000Z",
        after: "2026-07-05T12:00:00.000Z",
        timeZone: "Etc/UTC",
      })
    ).toBeNull();
    expect(
      nextOccurrence({
        rrule: "FREQ=DAILY;COUNT=2",
        scheduledStart: "2026-07-01T09:00:00.000Z",
        after: "2026-07-05T12:00:00.000Z",
        timeZone: "Etc/UTC",
      })
    ).toBeNull();
  });

  test("a summary never leaks rule syntax into a member-facing surface", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FREQS),
        fc.integer({ min: 1, max: 12 }),
        fc.uniqueArray(fc.constantFrom(...DAYS), {
          minLength: 1,
          maxLength: 3,
        }),
        (freq, interval, days) => {
          const byDay = freq === "WEEKLY" ? `BYDAY=${days.join(",")};` : "";
          const summary = describeRecurrence(
            `FREQ=${freq};INTERVAL=${interval};${byDay}UNTIL=20300105T000000Z`
          );
          expect(summary).not.toBeNull();
          expect(summary).not.toMatch(/FREQ=|BYDAY=|INTERVAL=|UNTIL=|\d{8}T/u);
          expect(summary).toContain("· until Jan 5, 2030");
        }
      ),
      { numRuns: 60, seed: 65631 }
    );
  });

  test("missed periods collapse onto one live occurrence and never stack", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), (weeks) => {
        const now = new Date(
          Date.parse("2026-08-01T12:00:00.000Z") + weeks * 7 * 86_400_000
        ).toISOString();
        const scheduled = collapseMissedOccurrences({
          rrule: "FREQ=WEEKLY",
          scheduledStart: "2026-08-01T09:00:00.000Z",
          timeZone: "Etc/UTC",
          anchor: "scheduled",
          now,
        });
        expect(scheduled.missed).toBe(weeks + 1);
        expect(Date.parse(scheduled.nextDue as string)).toBeGreaterThan(
          Date.parse(now)
        );
        expect(
          collapseMissedOccurrences({
            rrule: "FREQ=WEEKLY",
            scheduledStart: "2026-08-01T09:00:00.000Z",
            timeZone: "Etc/UTC",
            anchor: "completion",
            now,
            lastCompletedAt: "2026-08-01T10:00:00.000Z",
          }).missed
        ).toBeLessThanOrEqual(1);
      }),
      { numRuns: 13, seed: 65632 }
    );
  });
});

describe("exception laws", () => {
  const base = () => expandAllDay("FREQ=DAILY;COUNT=6", "2026-07-01");

  test("with no exceptions the series is returned untouched", () => {
    expect(applyRecurrenceExceptions(base(), [])).toStrictEqual(base());
  });

  test("a skip removes exactly its own occurrence and nothing else", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (index) => {
        const instances = base();
        const target = instances[index]?.originalStart as string;
        const out = applyRecurrenceExceptions(instances, [
          { originalStart: target, action: "skip" },
        ]);
        expect(out).toHaveLength(instances.length - 1);
        expect(out.some((i) => i.originalStart === target)).toBe(false);
      }),
      { numRuns: 24, seed: 65640 }
    );
  });

  test("an override moves `start` but never rewrites occurrence identity", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), (index) => {
        const instances = base();
        const target = instances[index]?.originalStart as string;
        const out = applyRecurrenceExceptions(instances, [
          { originalStart: target, action: "override", start: "2026-12-25" },
        ]);
        expect(out).toHaveLength(instances.length);
        const moved = out.find((i) => i.originalStart === target);
        expect(moved?.start).toBe("2026-12-25");
        for (const instance of out) {
          if (instance.originalStart === target) continue;
          expect(instance.start).toBe(instance.originalStart);
        }
      }),
      { numRuns: 24, seed: 65641 }
    );
  });

  test("an unknown originalStart matches nothing", () => {
    const instances = base();
    expect(
      applyRecurrenceExceptions(instances, [
        { originalStart: "1999-01-01", action: "skip" },
      ])
    ).toStrictEqual(instances);
  });

  test("a future-scope override shifts this and every later occurrence by the delta", () => {
    const instances = base();
    const out = applyRecurrenceExceptions(instances, [
      {
        originalStart: "2026-07-03",
        action: "override",
        scope: "future",
        start: "2026-07-05",
      },
    ]);
    expect(out.map((i) => i.start)).toStrictEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-05",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
    ]);
  });

  test("an occurrence-scope exception wins over an active future-scope one", () => {
    const out = applyRecurrenceExceptions(base(), [
      {
        originalStart: "2026-07-02",
        action: "override",
        scope: "future",
        start: "2026-07-04",
      },
      { originalStart: "2026-07-05", action: "skip" },
    ]);
    expect(out.some((i) => i.originalStart === "2026-07-05")).toBe(false);
    expect(out).toHaveLength(5);
  });

  test("shiftTemporal is invertible and preserves the value's shape", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "2026-07-01T09:00:00.000Z",
          "2026-07-01T09:00:00",
          "2026-07-01"
        ),
        fc.integer({ min: -5, max: 5 }),
        (value, days) => {
          const delta = days * 86_400_000;
          const shifted = shiftTemporal(value, delta);
          expect(shiftTemporal(shifted, -delta)).toBe(value);
          expect(shifted.endsWith("Z")).toBe(value.endsWith("Z"));
          expect(shifted.includes("T")).toBe(value.includes("T"));
        }
      ),
      { numRuns: 60, seed: 65642 }
    );
  });

  test("shiftTemporal returns an unparseable value unchanged", () => {
    expect(shiftTemporal("not-a-date", 86_400_000)).toBe("not-a-date");
  });
});
