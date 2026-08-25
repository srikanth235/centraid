/*
 * The CRON time zoo (#839). `cron-match.test.ts` states the DST doctrine on one
 * zone at two pinned transitions, which a matcher special-casing a whole-hour
 * northern positive-DST shift would pass. This re-states the same two laws from
 * docs/cron-timezone.md § "DST policy" (Gap → SKIP, Overlap → ONCE) over
 * adversarial zones and a seeded sample of minutes from each band.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { AutomationTriggerCursor } from "@centraid/server/engine";
import { useFakeClock } from "@centraid/test-kit/fake-clock";
import { seededRandom } from "@centraid/test-kit/random";

import { wallClockFields, wallClockMinuteKey } from "../cron-timezone.js";
import { dueInstants, readCronCursor } from "./cron-cursor.js";
import { cronMatches } from "./cron-match.js";

type Band = {
  readonly transitionUtc: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly fromMinute: number;
  readonly toMinute: number;
};

type ZooZone = {
  readonly zone: string;
  readonly why: string;
  readonly gap?: Band;
  readonly overlap?: Band;
};

/** Bands come from the runtime's own tzdata: a tzdata release that moves a
 *  zone's rules fails loudly here. */
const ZOO: readonly ZooZone[] = [
  {
    zone: "America/New_York",
    why: "the doctrine's pinned zone: whole-hour positive DST, both directions",
    gap: {
      transitionUtc: "2026-03-08T07:00:00.000Z",
      year: 2026,
      month: 3,
      day: 8,
      fromMinute: 2 * 60,
      toMinute: 3 * 60,
    },
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

const SAMPLES_PER_BAND = 4;

const ZOO_SEED = 839_012;

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

function pinnedExpr(band: Band, minuteOfDay: number): string {
  const hour = Math.floor(minuteOfDay / 60);
  const minute = minuteOfDay % 60;
  return `${minute} ${hour} ${band.day} ${band.month} *`;
}

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
    // Pinned, so a live `Date.now()` cannot make this pass only off-transition.
    useFakeClock("2026-06-15T12:00:00.000Z");
  });

  describe("gap law: a nonexistent wall minute never fires", () => {
    it.each(GAP_ZONES.map((entry) => [entry.zone, entry] as const))(
      "%s skips every sampled minute of its spring-forward band",
      (_zone, entry) => {
        const band = entry.gap as Band;
        const minutes = sampleMinutes(band, ZOO_SEED);
        const firing = minutes.filter(
          (minute) =>
            absoluteMatches(entry.zone, pinnedExpr(band, minute), band).length >
            0
        );
        expect(firing.map(hhmm)).toStrictEqual([]);
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
        // The control: without an ordinary neighbouring minute, "never matched" is also
        // satisfied by an expression the matcher cannot parse.
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
        // Two matches is the point — the dedupe below turns them into one delivery.
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
        // Keyed by `wallClockMinuteKey`: if the two copies keyed differently the
        // Overlap row would be unimplementable, so the collision IS the mechanism.
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
        // One window spanning both copies — the restart-gap shape.
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
        expect(result.elements).toHaveLength(1);
        expect(result.skipped).toBe(0);
        expect(result.gapReason).toBeUndefined();
      }
    );
  });

  describe("fixed-offset control", () => {
    it("Asia/Kolkata has neither a gap nor an overlap anywhere in 2026", () => {
      // The control zone: a matcher manufacturing a gap or overlap from the +05:30
      // base offset shows up here.
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
     * REGRESSION LOCK (#846 P2) for the Overlap row's "fires once".
     *
     * `dueInstants`' `seen` set is local to ONE call, so a gateway ticking once a
     * minute lands the two absolute minutes sharing a wall clock in two windows,
     * each deduping against itself and firing. `readCronCursor` therefore looks
     * back across windows, but only when the schedule's zone actually fell back.
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

        expect(fires).toHaveLength(1);
        // …and it is the EARLIER copy, the instant the policy names; the band is one
        // shift wide, so the later copy is suppressed.
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
        expect(fires).toStrictEqual([]);
      }
    );
  });
});
