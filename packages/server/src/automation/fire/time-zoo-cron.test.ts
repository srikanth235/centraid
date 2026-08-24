/*
 * The CRON time zoo (#839, gap G12).
 *
 * `cron-match.test.ts` states the DST doctrine on ONE zone
 * (America/New_York) at its two pinned 2026 transitions. That is the doctrine
 * demonstrated, not the doctrine tested: a matcher that special-cased a
 * whole-hour, northern-hemisphere, positive-DST shift would pass it.
 *
 * This file re-states the same two laws from docs/cron-timezone.md § "DST
 * policy" over a zoo of adversarial zones — a negative-DST zone whose standard
 * time is the summer one, a zone whose shift is thirty minutes rather than
 * sixty, and a fixed-offset zone that must never produce either case — and
 * over a SEEDED, deterministic sample of wall minutes drawn from inside each
 * transition band, so the law is asserted about the band and not about one
 * hand-picked minute inside it.
 *
 * docs/cron-timezone.md § "DST policy":
 *   Gap (spring-forward)  → SKIP: "the minute never matches any absolute
 *                           instant, so the automation does not fire that day
 *                           for that expression."
 *   Overlap (fall-back)   → ONCE: "matching can hit both absolute minutes, but
 *                           the cursor reader dedupes by zone wall-clock key so
 *                           the automation fires once for that wall-clock
 *                           minute."
 *
 * The overlap law is where the zoo found a real defect; see the
 * "continuously-running gateway" block at the bottom of this file.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { AutomationTriggerCursor } from "@centraid/server/engine";
import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { seededRandom } from "@centraid/test-kit/random";

import { wallClockFields, wallClockMinuteKey } from "../cron-timezone.js";
import { dueInstants, readCronCursor } from "./cron-cursor.js";
import { cronMatches } from "./cron-match.js";

/**
 * A civil day plus the half-open wall-clock band on it that a transition makes
 * nonexistent (a gap) or repeated (an overlap). Minutes are minute-of-day, so
 * a 30-minute shift is expressible without a second shape.
 */
type Band = {
  /** The offset change itself, as a UTC instant. */
  readonly transitionUtc: string;
  /** The civil date the band lies on, in the zone. */
  readonly year: number;
  readonly month: number;
  readonly day: number;
  /** Half-open [from, to) minute-of-day range of the affected wall clock. */
  readonly fromMinute: number;
  readonly toMinute: number;
};

type ZooZone = {
  readonly zone: string;
  /** Why this zone earns a seat — the property it adds that the others lack. */
  readonly why: string;
  readonly gap?: Band;
  readonly overlap?: Band;
};

/**
 * The zoo. Every band below was read off the runtime's own tzdata rather than
 * assumed; a zone whose rules move in a future tzdata release will fail these
 * tests loudly at the band, which is the intended signal.
 */
const ZOO: readonly ZooZone[] = [
  {
    zone: "America/New_York",
    why: "the doctrine's pinned zone: whole-hour positive DST, both directions",
    // docs/cron-timezone.md § "DST policy": "Spring-forward 2026-03-08".
    gap: {
      transitionUtc: "2026-03-08T07:00:00.000Z",
      year: 2026,
      month: 3,
      day: 8,
      fromMinute: 2 * 60,
      toMinute: 3 * 60,
    },
    // docs/cron-timezone.md § "DST policy": "Fall-back 2026-11-01".
    overlap: {
      transitionUtc: "2026-11-01T06:00:00.000Z",
      year: 2026,
      month: 11,
      day: 1,
      fromMinute: 1 * 60,
      toMinute: 2 * 60,
    },
  },
  {
    zone: "Europe/Dublin",
    why: "negative DST — IST is the STANDARD offset and winter is the shifted one, so a matcher that keys off an is-DST flag reads it backwards",
    gap: {
      transitionUtc: "2026-03-29T01:00:00.000Z",
      year: 2026,
      month: 3,
      day: 29,
      fromMinute: 1 * 60,
      toMinute: 2 * 60,
    },
    overlap: {
      transitionUtc: "2026-10-25T01:00:00.000Z",
      year: 2026,
      month: 10,
      day: 25,
      fromMinute: 1 * 60,
      toMinute: 2 * 60,
    },
  },
  {
    zone: "Australia/Lord_Howe",
    why: "a THIRTY-minute shift on a :30 base offset — the band is half an hour wide, so any hour-granular assumption survives New York and dies here",
    gap: {
      transitionUtc: "2026-10-03T15:30:00.000Z",
      year: 2026,
      month: 10,
      day: 4,
      fromMinute: 2 * 60,
      toMinute: 2 * 60 + 30,
    },
    overlap: {
      transitionUtc: "2026-04-04T15:00:00.000Z",
      year: 2026,
      month: 4,
      day: 5,
      fromMinute: 1 * 60 + 30,
      toMinute: 2 * 60,
    },
  },
  {
    zone: "Asia/Kolkata",
    why: "a fixed offset (+05:30, never shifts): the control that proves the laws below are about transitions and not about the matcher's zone path in general",
  },
];

/** How many wall minutes are drawn from each band. */
const SAMPLES_PER_BAND = 4;

/**
 * Seeded so the corpus varies across bands while any single failure replays
 * forever from the failing run's own output (see @centraid/test-kit/random).
 */
const ZOO_SEED = 839_012;

/** `SAMPLES_PER_BAND` distinct minute-of-day values inside `band`. */
function sampleMinutes(band: Band, seed: number): number[] {
  const rng = seededRandom(seed);
  const width = band.toMinute - band.fromMinute;
  const drawn = new Set<number>([band.fromMinute, band.toMinute - 1]);
  let guard = 0;
  while (drawn.size < Math.min(SAMPLES_PER_BAND, width) && guard < 100) {
    guard += 1;
    drawn.add(band.fromMinute + rng.int(0, width - 1));
  }
  return [...drawn].sort((left, right) => left - right);
}

/** A five-field expression pinned to one civil minute on one civil date. */
function pinnedExpr(band: Band, minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${minute} ${hour} ${band.day} ${band.month} *`;
}

/**
 * Every absolute minute within ±20h of the transition whose wall clock in
 * `zone` satisfies `expr`. Twenty hours each way covers the whole civil day
 * around any transition in the zoo, in either hemisphere.
 */
function absoluteMatches(zone: string, expr: string, band: Band): Date[] {
  const centre = Date.parse(band.transitionUtc);
  const out: Date[] = [];
  for (
    let t = centre - 20 * 3_600_000;
    t <= centre + 20 * 3_600_000;
    t += 60_000
  ) {
    const candidate = new Date(t);
    if (cronMatches(expr, candidate, zone)) out.push(candidate);
  }
  return out;
}

/** `HH:MM` of a minute-of-day, for readable failure output. */
function hhmm(minuteOfDay: number): string {
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  return `${hour}:${String(minuteOfDay % 60).padStart(2, "0")}`;
}

function cursorAt(positionMs: number): AutomationTriggerCursor {
  return {
    automationId: "zoo/one",
    triggerIndex: 0,
    sourceKind: "cron",
    positionJson: JSON.stringify(positionMs),
    skipped: 0,
    updatedAt: 0,
  };
}

const GAP_ZONES = ZOO.filter((entry) => entry.gap !== undefined);
const OVERLAP_ZONES = ZOO.filter((entry) => entry.overlap !== undefined);

describe("cron DST zoo", () => {
  beforeEach(() => {
    // Pinned so nothing in the matcher path can read a live wall clock and so
    // a future `Date.now()` inside it fails deterministically rather than on
    // the one day of the year the host is mid-transition.
    useFakeClock("2026-06-15T12:00:00.000Z");
  });

  describe("gap law: a nonexistent wall minute never fires", () => {
    it.each(GAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s skips every sampled minute of its spring-forward band",
      (_zone, entry) => {
        const band = entry.gap as Band;
        const minutes = sampleMinutes(band, ZOO_SEED);
        // docs/cron-timezone.md § "DST policy", Gap row: "the minute never
        // matches any absolute instant, so the automation does not fire that
        // day for that expression."
        const firing = minutes.filter(
          (minute) =>
            absoluteMatches(entry.zone, pinnedExpr(band, minute), band).length >
            0
        );
        expect(firing.map(hhmm)).toStrictEqual([]);
        // …and the same minutes are not merely unmatched but undeliverable:
        // the virtual stream over the whole transition day is empty too.
        const delivered = minutes.flatMap((minute) =>
          dueInstants(
            [{ expr: pinnedExpr(band, minute), timeZone: entry.zone }],
            new Date(Date.parse(band.transitionUtc) - 20 * 3_600_000),
            new Date(Date.parse(band.transitionUtc) + 20 * 3_600_000)
          )
        );
        expect(delivered).toStrictEqual([]);
      }
    );

    it.each(GAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s still fires the minute immediately BELOW its gap band",
      (_zone, entry) => {
        const band = entry.gap as Band;
        // The control the gap law needs: the band's lower neighbour is an
        // ordinary minute. Without it, "never matched" would also be satisfied
        // by an expression the matcher simply cannot parse.
        const below = band.fromMinute - 1;
        const matches = absoluteMatches(
          entry.zone,
          pinnedExpr(band, below),
          band
        );
        expect(matches).toHaveLength(1);
        const wall = wallClockFields(matches[0] as Date, entry.zone);
        expect([wall.year, wall.month, wall.day]).toStrictEqual([
          band.year,
          band.month,
          band.day,
        ]);
        expect(hhmm(wall.hour * 60 + wall.minute)).toBe(hhmm(below));
      }
    );
  });

  describe("overlap law: a repeated wall minute is one due instant", () => {
    it.each(OVERLAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s matches each sampled minute of its fall-back band exactly twice in absolute time",
      (_zone, entry) => {
        const band = entry.overlap as Band;
        const minutes = sampleMinutes(band, ZOO_SEED);
        // docs/cron-timezone.md § "DST policy", Overlap row: "matching can hit
        // both absolute minutes". Two is the whole point — the dedupe below is
        // what turns two matches into one delivery.
        const counts = minutes.map(
          (minute) =>
            absoluteMatches(entry.zone, pinnedExpr(band, minute), band).length
        );
        expect(counts).toStrictEqual(minutes.map(() => 2));
      }
    );

    it.each(OVERLAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s gives both absolute copies the SAME wall-clock dedupe key",
      (_zone, entry) => {
        const band = entry.overlap as Band;
        const minutes = sampleMinutes(band, ZOO_SEED);
        // The dedupe in cron-cursor.ts is keyed by `wallClockMinuteKey`. If the
        // two copies ever keyed differently, `dueInstants` would deliver both
        // and the Overlap row would be unimplementable — so the key collision
        // IS the mechanism, not an incidental detail.
        const distinctKeysPerMinute = minutes.map((minute) => {
          const copies = absoluteMatches(
            entry.zone,
            pinnedExpr(band, minute),
            band
          );
          return new Set(
            copies.map((copy) => wallClockMinuteKey(copy, entry.zone))
          ).size;
        });
        expect(distinctKeysPerMinute).toStrictEqual(minutes.map(() => 1));
      }
    );

    it.each(OVERLAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s collapses its fall-back band to one due instant per wall minute",
      (_zone, entry) => {
        const band = entry.overlap as Band;
        const minutes = sampleMinutes(band, ZOO_SEED);
        const centre = Date.parse(band.transitionUtc);
        // docs/cron-timezone.md § "DST policy", Overlap row: "the automation
        // fires once for that wall-clock minute." Asserted here over ONE window
        // spanning both copies — which is the restart-gap shape. The
        // continuously-ticking shape is pinned separately below.
        const perMinute = minutes.map(
          (minute) =>
            dueInstants(
              [{ expr: pinnedExpr(band, minute), timeZone: entry.zone }],
              new Date(centre - 20 * 3_600_000),
              new Date(centre + 20 * 3_600_000)
            ).length
        );
        expect(perMinute).toStrictEqual(minutes.map(() => 1));
      }
    );

    it.each(OVERLAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s reports no missed run for the repeated hour",
      (_zone, entry) => {
        const band = entry.overlap as Band;
        const centre = Date.parse(band.transitionUtc);
        const result = readCronCursor(
          [
            {
              expr: pinnedExpr(band, band.fromMinute),
              timeZone: entry.zone,
            },
          ],
          cursorAt(centre - 20 * 3_600_000),
          new Date(centre + 20 * 3_600_000)
        );
        // A phantom "you missed a run" is the user-visible failure mode of a
        // broken dedupe, so the count is asserted, not just the delivery.
        expect(result.elements).toHaveLength(1);
        expect(result.skipped).toBe(0);
        expect(result.gapReason).toBeUndefined();
      }
    );
  });

  describe("fixed-offset control", () => {
    it("Asia/Kolkata has neither a gap nor an overlap anywhere in 2026", () => {
      // The zoo's control zone: every wall minute of the year exists exactly
      // once, so a matcher bug that manufactured a gap or an overlap out of
      // the +05:30 base offset would show up here rather than nowhere.
      const fixed = ZOO.find((entry) => entry.zone === "Asia/Kolkata");
      expect(fixed?.gap).toBeUndefined();
      expect(fixed?.overlap).toBeUndefined();

      const rng = seededRandom(ZOO_SEED);
      const probes = Array.from({ length: 12 }, () => ({
        month: rng.int(1, 12),
        day: rng.int(1, 28),
        minuteOfDay: rng.int(0, 1439),
      }));
      const counts = probes.map((probe) => {
        const band: Band = {
          transitionUtc: new Date(
            Date.UTC(2026, probe.month - 1, probe.day, 12, 0, 0)
          ).toISOString(),
          year: 2026,
          month: probe.month,
          day: probe.day,
          fromMinute: probe.minuteOfDay,
          toMinute: probe.minuteOfDay + 1,
        };
        return absoluteMatches(
          "Asia/Kolkata",
          pinnedExpr(band, probe.minuteOfDay),
          band
        ).length;
      });
      expect(counts).toStrictEqual(probes.map(() => 1));
    });
  });

  describe("a continuously-running gateway across a fall-back", () => {
    /**
     * REGRESSION LOCK for #846 P2 — docs/cron-timezone.md § "DST policy",
     * Overlap row: "fires once for that wall-clock minute".
     *
     * The dedupe that delivers that promise lives in `dueInstants`
     * (cron-cursor.ts), and its `seen` set is local to ONE call. A gateway that
     * is UP across the transition ticks once a minute
     * (`setInterval(() => this.tick(), 60_000)`, cursor-engine.ts), so the two
     * absolute minutes carrying the same wall clock landed in two DIFFERENT
     * one-minute windows. Each deduped perfectly against itself and fired, so
     * the automation ran TWICE — "once" held only for a window wide enough to
     * contain both copies, i.e. after downtime, which is exactly the shape
     * `cron-cursor.test.ts` covers and why the gap went unseen.
     *
     * `readCronCursor` now looks back across windows for a wall-clock minute it
     * has already covered, and only when a schedule's zone actually fell back.
     * This suite is the continuous-tick shape the unit tests do not have, so it
     * is where the fix is locked.
     */
    it.each(OVERLAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s fires the repeated wall minute ONCE across a continuous tick",
      (_zone, entry) => {
        const band = entry.overlap as Band;
        const expr = pinnedExpr(band, band.fromMinute);
        const centre = Date.parse(band.transitionUtc);
        const fires: number[] = [];
        let cursor: AutomationTriggerCursor | undefined;
        for (let t = centre - 3_600_000; t <= centre + 3_600_000; t += 60_000) {
          const result = readCronCursor(
            [{ expr, timeZone: entry.zone }],
            cursor,
            new Date(t)
          );
          for (const element of result.elements) fires.push(element.occurredAt);
          if (result.positionJson !== undefined) {
            cursor = { ...cursorAt(t), positionJson: result.positionJson };
          }
        }

        // DOCUMENTED LAW: 1. OBSERVED: 1.
        expect(fires).toHaveLength(1);
        // …and it is the EARLIER of the two absolute minutes sharing that wall
        // clock, which is the instant the policy names: "an overlapping wall
        // time occurs once at the earlier instant". The band is exactly one
        // shift wide, so the earlier copy sits one shift before the offset
        // change and the later copy sits on it — the later one is suppressed.
        const shiftMs = (band.toMinute - band.fromMinute) * 60_000;
        expect(fires[0]).toBe(centre - shiftMs);
        expect(wallClockMinuteKey(new Date(fires[0]!), entry.zone)).toBe(
          wallClockMinuteKey(new Date(centre), entry.zone)
        );
      }
    );

    it.each(GAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s fires the nonexistent wall minute zero times, as documented",
      (_zone, entry) => {
        const band = entry.gap as Band;
        const expr = pinnedExpr(band, band.fromMinute);
        const centre = Date.parse(band.transitionUtc);
        const fires: number[] = [];
        let cursor: AutomationTriggerCursor | undefined;
        for (let t = centre - 3_600_000; t <= centre + 3_600_000; t += 60_000) {
          const result = readCronCursor(
            [{ expr, timeZone: entry.zone }],
            cursor,
            new Date(t)
          );
          for (const element of result.elements) fires.push(element.occurredAt);
          if (result.positionJson !== undefined) {
            cursor = { ...cursorAt(t), positionJson: result.positionJson };
          }
        }
        // The Gap row survives continuous ticking intact: a minute that exists
        // in no window cannot be delivered by any number of windows.
        expect(fires).toStrictEqual([]);
      }
    );
  });
});
