/*
 * ZONE-CROSSING recurrence collapse (issue #839, gap G12).
 *
 * A recurrence is DEFINED in one zone and READ from another: the schedule
 * carries `start_tz`, the viewer carries a device zone, and the window a
 * surface asks for is cut at the VIEWER's civil day boundaries. Those two
 * zones disagree about where a day starts, and on a transition day they also
 * disagree about how long one is. The failure mode is not a wrong label — it
 * is an occurrence delivered twice, or dropped, because it fell on a seam.
 *
 * docs/cron-timezone.md § intro: "`@centraid/core/time` … owns IANA wall-clock
 * resolution, RRULE expansion, … and stable original-occurrence identity."
 * docs/cron-timezone.md § "Matching": the client preview "uses the same
 * resolved zone so a mobile/web viewer does not re-interpret the schedule in
 * the device zone."
 *
 * The law this file states is the collapse law: **however the range is cut,
 * the occurrences are the same multiset, in the same order, once each.**
 * Split points are drawn from a seeded generator as well as from viewer-zone
 * midnights, so the law is asserted about arbitrary seams rather than about
 * the handful anyone thought to write down.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { seededRandom } from "@centraid/test-kit/random";

import { collapseMissedOccurrences } from "./recurrence-collapse.js";
import { expandRecurrence, nextOccurrence } from "./recurrence.js";
import type { RecurrenceInstance } from "./recurrence.js";
import { zonedParts } from "./timezone.js";

const ZOO_SEED = 839_022;

/**
 * A recurrence definition that crosses a transition in its OWN zone, plus the
 * transition it crosses. Each anchor is a real instant whose wall clock in the
 * definition zone is the intended civil time.
 */
type Crossing = {
  readonly label: string;
  readonly definitionZone: string;
  /** ISO instant of the series' first occurrence. */
  readonly start: string;
  /** The wall clock (`HH:MM:SS`) every occurrence must read in `definitionZone`. */
  readonly wallTime: string;
  /** Range the window walks, wide enough to contain the transition. */
  readonly rangeFrom: string;
  readonly rangeTo: string;
  /** What the definition zone does inside the range. */
  readonly transition: "gap" | "overlap";
};

const CROSSINGS: readonly Crossing[] = [
  {
    label: "New York daily 02:30 across the 2026 spring-forward",
    definitionZone: "America/New_York",
    // 02:30 America/New_York on 2026-03-06; 02:30 does not exist on 03-08.
    start: "2026-03-06T07:30:00.000Z",
    wallTime: "02:30:00",
    rangeFrom: "2026-03-05T00:00:00.000Z",
    rangeTo: "2026-03-13T00:00:00.000Z",
    transition: "gap",
  },
  {
    label: "New York daily 01:30 across the 2026 fall-back",
    definitionZone: "America/New_York",
    // 01:30 America/New_York on 2026-10-30; 01:30 happens twice on 11-01.
    start: "2026-10-30T05:30:00.000Z",
    wallTime: "01:30:00",
    rangeFrom: "2026-10-29T00:00:00.000Z",
    rangeTo: "2026-11-05T00:00:00.000Z",
    transition: "overlap",
  },
  {
    label: "Lord Howe daily 01:45 across the 2026 half-hour fall-back",
    definitionZone: "Australia/Lord_Howe",
    // 01:45 Australia/Lord_Howe on 2026-04-03; 01:45 happens twice on 04-05.
    start: "2026-04-02T14:45:00.000Z",
    wallTime: "01:45:00",
    rangeFrom: "2026-04-01T00:00:00.000Z",
    rangeTo: "2026-04-08T00:00:00.000Z",
    transition: "overlap",
  },
];

/** Viewer zones, chosen for the seams they cut the definition zone's day on. */
const VIEWERS: readonly { zone: string; why: string }[] = [
  { zone: "Etc/UTC", why: "the trivial seam — zero offset, no transitions" },
  {
    zone: "Asia/Kolkata",
    why: "a :30 offset that never shifts, so every viewer day boundary lands mid-hour in the definition zone",
  },
  {
    zone: "Asia/Kathmandu",
    why: "a :45 offset — the only quarter-hour class in tzdata",
  },
  {
    zone: "Pacific/Chatham",
    why: "a :45 offset that ALSO shifts for DST, so both zones are moving",
  },
];

const RRULE = "FREQ=DAILY";

/** Instants of local midnight in `zone` covering `[fromIso, toIso]`. */
function viewerMidnights(
  zone: string,
  fromIso: string,
  toIso: string
): number[] {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  const out: number[] = [];
  for (let t = from; t <= to; t += 60_000) {
    const parts = zonedParts(t, zone);
    if (parts.hour === 0 && parts.minute === 0) out.push(t);
  }
  return out;
}

/** A deterministic, sorted set of split instants strictly inside the range. */
function seededSplits(fromIso: string, toIso: string, count: number): number[] {
  const rng = seededRandom(ZOO_SEED);
  const from = Date.parse(fromIso);
  const span = Date.parse(toIso) - from;
  const drawn = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    drawn.add(from + rng.int(1, Math.floor(span / 60_000) - 1) * 60_000);
  }
  return [...drawn].sort((left, right) => left - right);
}

function expandInstances(
  crossing: Crossing,
  fromMs: number,
  toMs: number,
  zone = crossing.definitionZone
): RecurrenceInstance[] {
  return expandRecurrence({
    rrule: RRULE,
    start: crossing.start,
    rangeFrom: new Date(fromMs).toISOString(),
    rangeTo: new Date(toMs).toISOString(),
    timeZone: zone,
    semantics: "zoned",
    maxInstances: 50,
  });
}

function expandBetween(
  crossing: Crossing,
  fromMs: number,
  toMs: number,
  zone = crossing.definitionZone
): string[] {
  return expandInstances(crossing, fromMs, toMs, zone).map(
    (instance) => instance.start
  );
}

/** Walk `[rangeFrom, rangeTo)` as consecutive half-open pieces at `cuts`. */
function expandPiecewise(
  crossing: Crossing,
  cuts: readonly number[]
): string[] {
  const from = Date.parse(crossing.rangeFrom);
  const to = Date.parse(crossing.rangeTo);
  const bounds = [
    from,
    ...cuts.filter((cut) => cut > from && cut < to),
    to,
  ].sort((left, right) => left - right);
  const out: string[] = [];
  for (let index = 0; index < bounds.length - 1; index += 1) {
    out.push(
      ...expandBetween(
        crossing,
        bounds[index] as number,
        bounds[index + 1] as number
      )
    );
  }
  return out;
}

const CROSSING_ROWS = CROSSINGS.map(
  (crossing) => [crossing.label, crossing] as const
);

const MATRIX = CROSSINGS.flatMap((crossing) =>
  VIEWERS.map(
    (viewer) =>
      [
        `${crossing.label} — read from ${viewer.zone}`,
        crossing,
        viewer.zone,
      ] as const
  )
);

describe("zone-crossing recurrence collapse", () => {
  beforeEach(() => {
    useFakeClock("2026-06-15T12:00:00.000Z");
  });

  describe("collapse law: cutting the range never adds or drops an occurrence", () => {
    it.each(MATRIX)(
      "%s reproduces the whole-range series exactly",
      (_label, crossing, viewerZone) => {
        const whole = expandBetween(
          crossing,
          Date.parse(crossing.rangeFrom),
          Date.parse(crossing.rangeTo)
        );
        const cuts = viewerMidnights(
          viewerZone,
          crossing.rangeFrom,
          crossing.rangeTo
        );
        // A viewer whose day boundaries produced no cut would make this test
        // vacuous, so the seams are asserted to exist before they are used.
        expect(cuts.length).toBeGreaterThan(2);

        const piecewise = expandPiecewise(crossing, cuts);

        // Order AND multiplicity: `toStrictEqual` on the arrays catches the
        // duplicate (a boundary occurrence counted by both neighbours) and the
        // drop (counted by neither) that a half-open bug produces.
        expect(piecewise).toStrictEqual(whole);
        expect(new Set(piecewise).size).toBe(whole.length);
      }
    );

    it.each(CROSSING_ROWS)(
      "%s survives arbitrary seeded cut points, not just day boundaries",
      (_label, crossing) => {
        // Viewer midnights are the seams a surface actually asks for; arbitrary
        // seams are what proves the law is about the half-open window and not
        // about midnight. Seeded from a literal so a failure replays.
        const whole = expandBetween(
          crossing,
          Date.parse(crossing.rangeFrom),
          Date.parse(crossing.rangeTo)
        );
        const cuts = seededSplits(crossing.rangeFrom, crossing.rangeTo, 24);
        expect(cuts.length).toBeGreaterThan(10);

        expect(expandPiecewise(crossing, cuts)).toStrictEqual(whole);
      }
    );

    it.each(CROSSING_ROWS)(
      "%s emits each transition-day occurrence exactly once",
      (_label, crossing) => {
        const whole = expandBetween(
          crossing,
          Date.parse(crossing.rangeFrom),
          Date.parse(crossing.rangeTo)
        );
        // docs/cron-timezone.md § intro: skipped for a gap, once for an
        // overlap. Counting civil days in the DEFINITION zone is how a viewer
        // in any other zone would see it: one row per civil day, never two.
        const civilDays = whole.map((instant) => {
          const parts = zonedParts(instant, crossing.definitionZone);
          return Date.UTC(parts.year, parts.month - 1, parts.day);
        });
        expect(new Set(civilDays).size).toBe(whole.length);

        // The civil days a DAILY series lands on are consecutive — except that
        // a gap deletes exactly one of them, which is the whole doctrine
        // expressed as a shape rather than as a literal.
        const daySteps = civilDays
          .slice(1)
          .map(
            (day, index) => (day - (civilDays[index] as number)) / 86_400_000
          );
        const missingDays = daySteps.filter((step) => step === 2).length;
        expect(new Set(daySteps.filter((step) => step !== 2))).toStrictEqual(
          new Set([1])
        );
        expect(missingDays).toBe(crossing.transition === "gap" ? 1 : 0);
      }
    );
  });

  describe("the definition zone travels with the schedule", () => {
    it.each(MATRIX)(
      "%s keeps the definition zone's wall clock, not the reader's",
      (_label, crossing, viewerZone) => {
        // docs/cron-timezone.md § "Matching": a viewer "does not re-interpret
        // the schedule in the device zone". The observable form of that: every
        // occurrence reads the SAME wall clock in the definition zone, and
        // substituting the reader's zone changes the answer — if it did not,
        // the zone field would be decorative and a real re-interpretation bug
        // would be undetectable.
        const authoritative = expandInstances(
          crossing,
          Date.parse(crossing.rangeFrom),
          Date.parse(crossing.rangeTo)
        );
        const reinterpreted = expandInstances(
          crossing,
          Date.parse(crossing.rangeFrom),
          Date.parse(crossing.rangeTo),
          viewerZone
        );

        expect(
          new Set(authoritative.map((instance) => instance.wallStart.slice(11)))
        ).toStrictEqual(new Set([crossing.wallTime]));
        // The re-interpretation is self-consistent too — it just answers a
        // different question, in the reader's civil clock.
        expect(
          new Set(reinterpreted.map((instance) => instance.wallStart.slice(11)))
            .size
        ).toBe(1);
        // Same anchor (the series' own first instant is a fact, not a zone
        // reading), different series after the definition zone shifts.
        expect(reinterpreted[0]?.start).toBe(authoritative[0]?.start);
        expect(
          reinterpreted.map((instance) => instance.start)
        ).not.toStrictEqual(authoritative.map((instance) => instance.start));
      }
    );
  });

  describe("missed-run collapse across a transition", () => {
    it("counts the skipped spring-forward day zero times", () => {
      // The gap day produced no occurrence, so it cannot be a missed run. A
      // collapse that counted civil days rather than occurrences would tell the
      // member they missed a run that never existed.
      const collapsed = collapseMissedOccurrences({
        rrule: RRULE,
        scheduledStart: "2026-03-06T07:30:00.000Z",
        timeZone: "America/New_York",
        now: "2026-03-11T12:00:00.000Z",
      });
      // 03-06, 03-07, (03-08 skipped), 03-09, 03-10, 03-11 → five elapsed.
      expect(collapsed).toStrictEqual({
        missed: 5,
        nextDue: "2026-03-12T06:30:00.000Z",
      });
    });

    it("counts the repeated fall-back hour exactly once", () => {
      const collapsed = collapseMissedOccurrences({
        rrule: RRULE,
        scheduledStart: "2026-10-30T05:30:00.000Z",
        timeZone: "America/New_York",
        now: "2026-11-03T12:00:00.000Z",
      });
      // 10-30, 10-31, 11-01 (once, not twice), 11-02, 11-03 → five elapsed.
      expect(collapsed).toStrictEqual({
        missed: 5,
        nextDue: "2026-11-04T06:30:00.000Z",
      });
    });

    it.each(VIEWERS.map((viewer) => [viewer.zone] as const))(
      "is identical whichever zone (%s) the reader is in",
      (viewerZone) => {
        // `now` is an instant, so the reader's zone must not enter the answer
        // at all. Asserted rather than assumed: a device-zone read sneaking
        // into the collapse would show up as a member in Kathmandu seeing a
        // different overdue count from a member in New York.
        const now = "2026-11-03T12:00:00.000Z";
        const definitionNow = zonedParts(now, "America/New_York");
        const viewerNow = zonedParts(now, viewerZone);
        // The reader really is on a different civil clock at this instant —
        // without that, "independent of the reader" would be untested.
        expect([viewerNow.day, viewerNow.hour]).not.toStrictEqual([
          definitionNow.day,
          definitionNow.hour,
        ]);
        // …and still gets the one answer the definition zone dictates.
        expect(
          collapseMissedOccurrences({
            rrule: RRULE,
            scheduledStart: "2026-10-30T05:30:00.000Z",
            timeZone: "America/New_York",
            now,
          })
        ).toStrictEqual({
          missed: 5,
          nextDue: "2026-11-04T06:30:00.000Z",
        });
      }
    );

    it("never returns the second copy of a repeated wall minute as the next due", () => {
      // Standing inside the repeated hour, the next occurrence is TOMORROW's
      // 01:30, not the hour's second 01:30. Returning the second copy is the
      // recurrence-side shape of the cron double-fire.
      const insideRepeatedHour = "2026-11-01T05:45:00.000Z";
      const next = nextOccurrence({
        rrule: RRULE,
        scheduledStart: "2026-10-30T05:30:00.000Z",
        after: insideRepeatedHour,
        timeZone: "America/New_York",
      });
      expect(next).toBe("2026-11-02T06:30:00.000Z");
      const wall = zonedParts(next as string, "America/New_York");
      expect([wall.month, wall.day, wall.hour, wall.minute]).toStrictEqual([
        11, 2, 1, 30,
      ]);
    });
  });
});
