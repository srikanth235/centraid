/**
 * Recurrence laws (#656 Layer 3 mutation seed).
 *
 * `recurrence.test.ts` pins six concrete expansions. Those prove the engine
 * runs; they do not prove it detects. A mutant that drops the `emitted >=
 * rule.count` guard, flips `value >= from` to `>`, or removes the
 * `firstPeriodAtOrAfter` back-off still reproduces every asserted array.
 *
 * These tests state the laws instead: monotonicity, the COUNT/UNTIL bounds,
 * cadence spacing, BYDAY membership, exception identity, and the parser's
 * normalisation contract — each for arbitrary inputs.
 */
import { describe, expect, test } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  applyRecurrenceExceptions,
  canonicalizeRrule,
  describeRecurrence,
  expandRecurrence,
  nextOccurrence,
  parseRrule,
  rruleLine,
  shiftTemporal,
} from "./recurrence.js";

const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/** All-day expansion over a wide window — pure civil arithmetic, no zone. */
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

describe("rrule normalisation", () => {
  test("canonicalizeRrule is idempotent and strips exactly one RRULE: prefix", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FREQS),
        fc.integer({ min: 1, max: 30 }),
        fc.constantFrom("", "RRULE:", "rrule:", "  RRULE:"),
        (freq, interval, prefix) => {
          const raw = `${prefix}FREQ=${freq};INTERVAL=${interval}`;
          const once = canonicalizeRrule(raw);
          expect(canonicalizeRrule(once)).toBe(once);
          expect(once).toBe(`FREQ=${freq};INTERVAL=${interval}`);
          expect(once.startsWith("RRULE")).toBe(false);
        }
      ),
      { numRuns: 120, seed: 65610 }
    );
  });

  test("rruleLine always emits exactly one prefix and never double-prefixes", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FREQS), (freq) => {
        const line = rruleLine(`FREQ=${freq}`);
        expect(line).toBe(`RRULE:FREQ=${freq}`);
        expect(rruleLine(line)).toBe(line);
        expect(line.match(/RRULE:/gu)).toHaveLength(1);
      }),
      { numRuns: 40, seed: 65611 }
    );
  });

  test("an empty body yields an empty line, not a bare RRULE: header", () => {
    expect(rruleLine("")).toBe("");
    expect(rruleLine("RRULE:")).toBe("");
    expect(rruleLine("   ")).toBe("");
  });

  test("parsing ignores case, whitespace, and the RRULE: prefix alike", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FREQS),
        fc.integer({ min: 1, max: 12 }),
        (freq, interval) => {
          const canonical = parseRrule(`FREQ=${freq};INTERVAL=${interval}`);
          expect(
            parseRrule(
              `RRULE: freq=${freq.toLowerCase()} ;interval=${interval} `
            )
          ).toStrictEqual(canonical);
        }
      ),
      { numRuns: 100, seed: 65612 }
    );
  });

  test("a missing or unknown FREQ is rejected, never defaulted", () => {
    for (const bad of ["", "INTERVAL=2", "FREQ=HOURLY", "FREQ=", "garbage"]) {
      expect(parseRrule(bad), bad).toBeNull();
      expect(describeRecurrence(bad), bad).toBeNull();
    }
  });

  test("non-positive INTERVAL/COUNT collapse to 1 rather than looping forever", () => {
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 0 }), (n) => {
        expect(parseRrule(`FREQ=DAILY;INTERVAL=${n}`)?.interval).toBe(1);
        expect(parseRrule(`FREQ=DAILY;COUNT=${n}`)?.count).toBe(1);
      }),
      { numRuns: 60, seed: 65613 }
    );
    // A non-numeric INTERVAL falls back to the default of 1, not NaN.
    expect(parseRrule("FREQ=DAILY;INTERVAL=x")?.interval).toBe(1);
    expect(parseRrule("FREQ=DAILY;COUNT=x")?.count).toBeUndefined();
  });

  test("BYDAY keeps only the seven ICS day tokens and drops an all-junk list", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...DAYS), {
          minLength: 1,
          maxLength: 7,
        }),
        (days) => {
          const parsed = parseRrule(
            `FREQ=WEEKLY;BYDAY=${[...days, "XX", "1MO"].join(",")}`
          );
          expect(parsed?.byDay).toStrictEqual(days);
        }
      ),
      { numRuns: 80, seed: 65614 }
    );
    expect(parseRrule("FREQ=WEEKLY;BYDAY=XX,YY")?.byDay).toBeUndefined();
  });

  test("describeRecurrence is defined exactly when the rule parses", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "FREQ=DAILY",
          "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
          "FREQ=MONTHLY;COUNT=3",
          "FREQ=YEARLY;UNTIL=20301231T000000Z",
          "FREQ=HOURLY",
          "nonsense"
        ),
        (rrule) => {
          expect(describeRecurrence(rrule) === null).toBe(
            parseRrule(rrule) === null
          );
        }
      ),
      { numRuns: 60, seed: 65615 }
    );
    // Singular for interval 1, plural otherwise — the count/until tail is
    // mutually exclusive (COUNT wins over UNTIL).
    expect(describeRecurrence("FREQ=DAILY")).toBe("Every day");
    expect(describeRecurrence("FREQ=DAILY;INTERVAL=3")).toBe("Every 3 days");
    expect(
      describeRecurrence("FREQ=DAILY;COUNT=2;UNTIL=20301231T000000Z")
    ).toBe("Every day, 2 times");
    expect(describeRecurrence("FREQ=DAILY;UNTIL=20301231T000000Z")).toBe(
      "Every day until 20301231T000000Z"
    );
  });
});

describe("expansion laws", () => {
  test("instances are strictly increasing and never precede the anchor", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FREQS),
        fc.integer({ min: 1, max: 5 }),
        (freq, interval) => {
          const start = "2026-02-14";
          const out = expandAllDay(`FREQ=${freq};INTERVAL=${interval}`, start);
          expect(out.length).toBeGreaterThan(0);
          const starts = out.map((instance) => instance.start);
          // Strictly increasing, and never before the anchor.
          expect([...starts].sort()).toStrictEqual(starts);
          expect(new Set(starts).size).toBe(starts.length);
          expect(starts.every((value) => value >= start)).toBe(true);
        }
      ),
      { numRuns: 80, seed: 65620 }
    );
  });

  test("COUNT is an exact upper bound on everything the series ever emits", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FREQS),
        fc.integer({ min: 1, max: 12 }),
        (freq, count) => {
          const out = expandAllDay(
            `FREQ=${freq};COUNT=${count}`,
            "2026-01-05",
            200
          );
          expect(out).toHaveLength(count);
        }
      ),
      { numRuns: 80, seed: 65621 }
    );
  });

  test("maxInstances caps the result and 1 is the floor", () => {
    fc.assert(
      fc.property(fc.integer({ min: -5, max: 25 }), (max) => {
        const out = expandAllDay("FREQ=DAILY", "2026-01-05", max);
        expect(out).toHaveLength(Math.max(1, max));
      }),
      { numRuns: 60, seed: 65622 }
    );
  });

  test("UNTIL is inclusive and nothing is emitted past it", () => {
    const out = expandRecurrence({
      rrule: "FREQ=DAILY;UNTIL=20260110T000000Z",
      start: "2026-01-05T00:00:00.000Z",
      rangeFrom: "2026-01-01T00:00:00.000Z",
      rangeTo: "2026-02-01T00:00:00.000Z",
      timeZone: "Etc/UTC",
      maxInstances: 50,
    });
    expect(out.map((i) => i.start)).toStrictEqual([
      "2026-01-05T00:00:00.000Z",
      "2026-01-06T00:00:00.000Z",
      "2026-01-07T00:00:00.000Z",
      "2026-01-08T00:00:00.000Z",
      "2026-01-09T00:00:00.000Z",
      "2026-01-10T00:00:00.000Z",
    ]);
  });

  test("DAILY cadence spacing is exactly INTERVAL days of wall clock", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), (interval) => {
        const out = expandAllDay(
          `FREQ=DAILY;INTERVAL=${interval}`,
          "2026-03-01",
          8
        );
        for (let i = 1; i < out.length; i++) {
          const prev = Date.parse(`${out[i - 1]?.start as string}T00:00:00Z`);
          const next = Date.parse(`${out[i]?.start as string}T00:00:00Z`);
          expect(next - prev).toBe(interval * 86_400_000);
        }
      }),
      { numRuns: 60, seed: 65623 }
    );
  });

  test("MONTHLY cadence advances exactly INTERVAL calendar months", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), (interval) => {
        const out = expandAllDay(
          `FREQ=MONTHLY;INTERVAL=${interval}`,
          "2026-01-15",
          8
        );
        const months = out.map((instance) => {
          const [year, month] = instance.start.split("-").map(Number);
          return (year as number) * 12 + (month as number);
        });
        const gaps = months.slice(1).map((m, i) => m - (months[i] as number));
        expect(gaps).toStrictEqual(gaps.map(() => interval));
      }),
      { numRuns: 50, seed: 65624 }
    );
  });

  test("YEARLY is twelve months, not twelve of anything else", () => {
    const out = expandAllDay("FREQ=YEARLY", "2026-06-09", 4);
    expect(out.map((i) => i.start)).toStrictEqual([
      "2026-06-09",
      "2027-06-09",
      "2028-06-09",
      "2029-06-09",
    ]);
  });

  test("every WEEKLY BYDAY instance falls on a requested weekday", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.constantFrom(...DAYS), {
          minLength: 1,
          maxLength: 4,
        }),
        (days) => {
          const out = expandAllDay(
            `FREQ=WEEKLY;BYDAY=${days.join(",")}`,
            "2026-04-01",
            20
          );
          const wanted = new Set(days.map((d) => DAYS.indexOf(d)));
          expect(out.length).toBeGreaterThan(0);
          for (const instance of out) {
            const weekday = new Date(`${instance.start}T00:00:00Z`).getUTCDay();
            expect(wanted.has(weekday), instance.start).toBe(true);
          }
        }
      ),
      { numRuns: 80, seed: 65625 }
    );
  });

  test("a window that ends before it starts expands to nothing", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FREQS), (freq) => {
        expect(
          expandRecurrence({
            rrule: `FREQ=${freq}`,
            start: "2026-01-01",
            rangeFrom: "2026-06-01",
            rangeTo: "2026-05-01",
            semantics: "all-day",
          })
        ).toStrictEqual([]);
        // An empty (from === to) window is empty too.
        expect(
          expandRecurrence({
            rrule: `FREQ=${freq}`,
            start: "2026-01-01",
            rangeFrom: "2026-06-01",
            rangeTo: "2026-06-01",
            semantics: "all-day",
          })
        ).toStrictEqual([]);
      }),
      { numRuns: 40, seed: 65626 }
    );
  });

  test("an unparseable rule or start expands to nothing rather than throwing", () => {
    for (const bad of [
      { rrule: "FREQ=HOURLY", start: "2026-01-01" },
      { rrule: "FREQ=DAILY", start: "not-a-date" },
      { rrule: "", start: "2026-01-01" },
    ]) {
      expect(
        expandRecurrence({
          ...bad,
          rangeFrom: "2026-01-01",
          rangeTo: "2027-01-01",
          semantics: "all-day",
        })
      ).toStrictEqual([]);
    }
    // Zoned semantics without a timeZone cannot resolve a civil clock.
    expect(
      expandRecurrence({
        rrule: "FREQ=DAILY",
        start: "2026-01-01T00:00:00.000Z",
        rangeFrom: "2026-01-01T00:00:00.000Z",
        rangeTo: "2026-02-01T00:00:00.000Z",
      })
    ).toStrictEqual([]);
  });

  test("the analytic fast-forward lands on the same instances as a full walk", () => {
    // firstPeriodAtOrAfter only runs for unbounded rules; it must never skip
    // an occurrence the naive walk would have produced.
    fc.assert(
      fc.property(
        fc.constantFrom(...FREQS),
        fc.integer({ min: 1, max: 4 }),
        (freq, interval) => {
          const rrule = `FREQ=${freq};INTERVAL=${interval}`;
          const full = expandRecurrence({
            rrule,
            start: "2020-01-07",
            rangeFrom: "2020-01-07",
            rangeTo: "2035-01-01",
            semantics: "all-day",
            maxInstances: 10_000,
          });
          const windowed = expandRecurrence({
            rrule,
            start: "2020-01-07",
            rangeFrom: "2030-01-01",
            rangeTo: "2032-01-01",
            semantics: "all-day",
            maxInstances: 10_000,
          });
          const expected = full
            .filter((i) => i.start >= "2030-01-01" && i.start < "2032-01-01")
            .map((i) => i.start);
          expect(windowed.map((i) => i.start)).toStrictEqual(expected);
        }
      ),
      { numRuns: 32, seed: 65627 }
    );
  });

  test("zoned instances keep one wall clock across a DST boundary", () => {
    const out = expandRecurrence({
      rrule: "FREQ=DAILY;COUNT=4",
      start: "2026-10-30T13:00:00.000Z",
      rangeFrom: "2026-10-01T00:00:00.000Z",
      rangeTo: "2026-12-01T00:00:00.000Z",
      timeZone: "America/New_York",
    });
    // Same civil 09:00 on both sides of the fall-back; the UTC instant moves.
    expect(out.map((i) => i.wallStart)).toStrictEqual([
      "2026-10-30T09:00:00",
      "2026-10-31T09:00:00",
      "2026-11-01T09:00:00",
      "2026-11-02T09:00:00",
    ]);
    expect(out.at(-1)?.start).toBe("2026-11-02T14:00:00.000Z");
    expect(out[0]?.start).toBe("2026-10-30T13:00:00.000Z");
  });

  test("all-day instances carry no time component and never claim an overlap", () => {
    const out = expandAllDay("FREQ=DAILY;COUNT=5", "2026-03-06");
    for (const instance of out) {
      expect(instance.start).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(instance.wallStart).toBe(instance.start);
      expect(instance.originalStart).toBe(instance.start);
      expect(instance.overlap).toBe(false);
    }
  });
});

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
    // COUNT exhausted before `after` — the series is over.
    expect(
      nextOccurrence({
        rrule: "FREQ=DAILY;COUNT=2",
        scheduledStart: "2026-07-01T09:00:00.000Z",
        after: "2026-07-05T12:00:00.000Z",
        timeZone: "Etc/UTC",
      })
    ).toBeNull();
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
        // Every other occurrence is byte-identical.
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
    // +2 days from the third occurrence onward; the first two are untouched.
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
          // A zoned instant stays zoned; a floating/all-day value stays naive.
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
