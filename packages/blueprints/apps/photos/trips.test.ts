// What a trip is CALLED, and the line drawn across it (#816).
//
// The vault owns whether a run of days is a trip at all
// (`packages/vault/src/enrich/memories.test.ts`); nothing here re-tests that.
// What these cases own is the display layer's two claims: a title a person
// would say out loud, and a route a card can sketch offline — plus the two
// things a title must NEVER be, which is the reason this module exists at all:
// a coordinate, or a phrase relative to where the member lives.
import { describe, expect, it } from "vitest";

import {
  awayDaysOf,
  hintDayCount,
  resolveHomeKey,
  tripFacts,
  tripPlaceName,
  tripRoute,
} from "./trips.ts";
import type { TripMember, TripPlace } from "./trips.ts";

const TAHOE: TripPlace = {
  key: "place-tahoe",
  name: "39.09680, -120.03240",
  gazetteer: "South Lake Tahoe, CA",
  lat: 39.0968,
  lng: -120.0324,
};

const TRUCKEE: TripPlace = {
  key: "place-truckee",
  name: null,
  gazetteer: "Truckee, CA",
  lat: 39.328,
  lng: -120.1833,
};

const HOME: TripPlace = {
  key: "place-home",
  name: "Home",
  lat: 37.4419,
  lng: -122.143,
};

/** One frame at `place`, captured at noon UTC on `day`. */
const frame = (
  day: string,
  place: TripPlace | null = null,
  hour = 12
): TripMember => ({
  capturedAt: `${day}T${String(hour).padStart(2, "0")}:00:00Z`,
  place,
});

/** Consecutive days from `start`, one frame each, all at `place`. */
function run(start: string, days: number, place: TripPlace): TripMember[] {
  const base = Date.parse(`${start}T12:00:00Z`);
  return Array.from({ length: days }, (_, index) => ({
    capturedAt: new Date(base + index * 86_400_000).toISOString(),
    place,
  }));
}

describe("a trip's title", () => {
  it("calls a two-day span over a weekend a weekend", () => {
    // 2026-08-15 is a Saturday, 2026-08-16 a Sunday.
    const facts = tripFacts({
      members: run("2026-08-15", 2, TAHOE),
      homePlaceKey: HOME.key,
      titleHint: "2-day trip",
    });
    expect(facts).toMatchObject({
      awayDays: 2,
      includesWeekend: true,
      title: "Weekend in South Lake Tahoe, CA",
    });
  });

  it("calls a three-day span that reaches a Sunday a weekend", () => {
    // Saturday, Sunday, Monday — the long weekend the ceiling exists for.
    const facts = tripFacts({
      members: run("2026-08-15", 3, TRUCKEE),
      homePlaceKey: HOME.key,
      titleHint: "3-day trip",
    });
    expect(facts.title).toBe("Weekend in Truckee, CA");
  });

  it("counts a midweek pair in days, not weekends", () => {
    // Tuesday and Wednesday: the same length, no weekend in it.
    const facts = tripFacts({
      members: run("2026-08-18", 2, TRUCKEE),
      homePlaceKey: HOME.key,
      titleHint: "2-day trip",
    });
    expect(facts).toMatchObject({
      includesWeekend: false,
      title: "2 days in Truckee, CA",
    });
  });

  it("calls a seven-day span a week", () => {
    const facts = tripFacts({
      members: run("2026-08-10", 7, TRUCKEE),
      homePlaceKey: HOME.key,
      titleHint: "7-day trip",
    });
    expect(facts.title).toBe("A week in Truckee, CA");
  });

  it("states a long trip's length as a numeral", () => {
    const facts = tripFacts({
      members: run("2026-08-01", 12, TRUCKEE),
      homePlaceKey: HOME.key,
      titleHint: "12-day trip",
    });
    expect(facts.title).toBe("12 days in Truckee, CA");
  });

  it("keeps the detector's bare hint when no rung can name the place", () => {
    // A place minted from GPS and never renamed, with no gazetteer installed:
    // the ONE case where the title has nothing to say but the day count.
    const unnamed: TripPlace = {
      key: "place-x",
      name: "39.09680, -120.03240",
      lat: 39.0968,
      lng: -120.0324,
    };
    const facts = tripFacts({
      members: run("2026-08-15", 2, unnamed),
      homePlaceKey: HOME.key,
      titleHint: "2-day trip",
    });
    expect(facts).toMatchObject({ placeName: null, title: "2-day trip" });
  });

  it("keeps the hint's shape when the detector sent no hint at all", () => {
    const facts = tripFacts({
      members: run("2026-08-18", 2, { key: "place-x", lat: 1, lng: 2 }),
      homePlaceKey: HOME.key,
    });
    expect(facts.title).toBe("2-day trip");
  });

  it("prefers a name the member typed over the gazetteer's", () => {
    const named: TripPlace = { ...TAHOE, name: "The cabin" };
    expect(
      tripFacts({
        members: run("2026-08-15", 2, named),
        homePlaceKey: HOME.key,
        titleHint: "2-day trip",
      }).title
    ).toBe("Weekend in The cabin");
  });

  it("names the modal away place, not the first one seen", () => {
    const facts = tripFacts({
      members: [
        frame("2026-08-15", TRUCKEE, 9),
        frame("2026-08-15", TAHOE, 10),
        frame("2026-08-15", TAHOE, 11),
        frame("2026-08-16", TAHOE, 12),
      ],
      homePlaceKey: HOME.key,
      titleHint: "2-day trip",
    });
    expect(facts.title).toBe("Weekend in South Lake Tahoe, CA");
  });

  it("honours the detector's own modal place when it hands one over", () => {
    // Same frames, but the vault says Truckee — the projection and the card
    // must agree about which place the trip was "in".
    const facts = tripFacts({
      members: [
        frame("2026-08-15", TRUCKEE, 9),
        frame("2026-08-15", TAHOE, 10),
        frame("2026-08-15", TAHOE, 11),
      ],
      homePlaceKey: HOME.key,
      titleHint: "2-day trip",
      placeKey: TRUCKEE.key,
    });
    expect(facts.title).toBe("Weekend in Truckee, CA");
  });

  it("falls to the next away place when the detector's own has no name", () => {
    const unnamed: TripPlace = { key: "place-x", name: "1.00000, 2.00000" };
    const facts = tripFacts({
      members: [
        frame("2026-08-15", unnamed, 9),
        frame("2026-08-15", unnamed, 10),
        frame("2026-08-16", TRUCKEE, 11),
      ],
      homePlaceKey: HOME.key,
      titleHint: "2-day trip",
      placeKey: unnamed.key,
    });
    expect(facts.title).toBe("Weekend in Truckee, CA");
  });

  it("never names home, even when the trip came back through it", () => {
    // The vault's rule makes a same-day return's home frames trip members.
    const facts = tripFacts({
      members: [
        ...run("2026-08-15", 2, TAHOE),
        frame("2026-08-16", HOME, 22),
        frame("2026-08-16", HOME, 23),
      ],
      homePlaceKey: HOME.key,
      titleHint: "2-day trip",
    });
    expect(facts.title).toBe("Weekend in South Lake Tahoe, CA");
    expect(facts.title).not.toContain("Home");
  });

  it("prints no coordinate and no bearing from home for any of these shapes", () => {
    const shapes = [
      run("2026-08-15", 2, TAHOE),
      run("2026-08-18", 2, TRUCKEE),
      run("2026-08-10", 7, { ...TAHOE, gazetteer: null }),
      [frame("2026-08-15"), frame("2026-08-16", TAHOE)],
      [{ place: TAHOE }, { capturedAt: "", place: TRUCKEE }],
      [],
    ];
    for (const members of shapes) {
      const { title } = tripFacts({
        members,
        homePlaceKey: HOME.key,
        titleHint: "2-day trip",
      });
      expect(title ?? "").not.toMatch(/-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+/u);
      expect(title ?? "").not.toMatch(/\bof Home\b|\bkm\b|\bm [NSEW]/u);
    }
  });
});

describe("a trip's day span", () => {
  it("counts only away days, never the days spent at home", () => {
    const members = [
      frame("2026-08-14", HOME),
      ...run("2026-08-15", 2, TAHOE),
      frame("2026-08-17", HOME),
    ];
    expect(awayDaysOf(members, HOME.key)).toStrictEqual([
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("counts every placed day when no home place is known", () => {
    const members = [frame("2026-08-15", HOME), frame("2026-08-16", TAHOE)];
    expect(awayDaysOf(members, null)).toHaveLength(2);
  });

  it("leaves an unplaced day out of the away count without dropping it", () => {
    // A day inside the trip with no located frame is a day the vault bridged;
    // its count lives in the hint, and the hint outranks the derived number.
    const facts = tripFacts({
      members: [
        ...run("2026-08-15", 2, TAHOE),
        frame("2026-08-17"),
        frame("2026-08-18"),
      ],
      homePlaceKey: HOME.key,
      titleHint: "4-day trip",
    });
    expect(facts.awayDays).toBe(2);
    expect(facts.title).toBe("4 days in South Lake Tahoe, CA");
  });

  it("reads the trip's own day key in the camera's zone, not the reader's", () => {
    // 01:30 UTC on the Monday is still Sunday evening in California, so the
    // trip that ended then covered a weekend.
    const members = [
      { capturedAt: "2026-08-15T20:00:00Z", tzOffsetMin: -420, place: TAHOE },
      { capturedAt: "2026-08-17T01:30:00Z", tzOffsetMin: -420, place: TAHOE },
    ];
    expect(awayDaysOf(members, HOME.key)).toStrictEqual([
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("reads the detector's hint as the authoritative day count", () => {
    expect(hintDayCount("3-day trip")).toBe(3);
    expect(hintDayCount("12-day trip")).toBe(12);
    expect(hintDayCount("Three days in Mysuru")).toBeNull();
    expect(hintDayCount(null)).toBeNull();
  });
});

describe("a trip's route", () => {
  it("orders the distinct places by first capture and counts their frames", () => {
    const route = tripRoute([
      frame("2026-08-15", TRUCKEE, 9),
      frame("2026-08-15", TAHOE, 10),
      frame("2026-08-16", TRUCKEE, 11),
      frame("2026-08-16", TAHOE, 12),
    ]);
    expect(route.map((point) => point.key)).toStrictEqual([
      TRUCKEE.key,
      TAHOE.key,
    ]);
    expect(route.map((point) => point.count)).toStrictEqual([2, 2]);
    expect(route[0]).toMatchObject({
      lat: TRUCKEE.lat,
      lng: TRUCKEE.lng,
      name: "Truckee, CA",
    });
  });

  it("tolerates members with no place and no coordinate", () => {
    const route = tripRoute([
      frame("2026-08-15"),
      frame("2026-08-15", { key: "place-room", name: "The studio" }),
      frame("2026-08-16", TAHOE),
    ]);
    expect(route).toHaveLength(1);
    expect(route[0]!.key).toBe(TAHOE.key);
  });

  it("draws one dot for a trip that stayed in one place", () => {
    expect(tripRoute(run("2026-08-15", 2, TAHOE))).toHaveLength(1);
  });

  it("names a route point by the same two rungs the title uses", () => {
    expect(tripPlaceName(TAHOE)).toBe("South Lake Tahoe, CA");
    expect(tripPlaceName({ ...TAHOE, name: "The cabin" })).toBe("The cabin");
    expect(tripPlaceName({ key: "k", name: "1.00000, 2.00000" })).toBeNull();
    expect(tripPlaceName(null)).toBeNull();
  });
});

describe("resolving home for the away test", () => {
  it("takes the tagged home place, whatever the modal place is", () => {
    expect(
      resolveHomeKey(run("2026-08-15", 9, TAHOE), [HOME.key, "place-zzz"])
    ).toBe(HOME.key);
  });

  it("falls back to the modal place across the whole library", () => {
    const library = [
      ...run("2026-06-01", 5, HOME),
      ...run("2026-08-15", 2, TAHOE),
    ];
    expect(resolveHomeKey(library)).toBe(HOME.key);
  });

  it("has no answer for a library with no place anywhere", () => {
    expect(
      resolveHomeKey([frame("2026-08-15"), frame("2026-08-16")])
    ).toBeNull();
  });
});
