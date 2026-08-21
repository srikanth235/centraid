import { describe, expect, it } from "vitest";

import type { NamedPlace } from "./place-phrase.ts";
import {
  PLACE_NO_NAME,
  bearingDegrees,
  compassPoint,
  distanceKm,
  exactLocation,
  formatDistance,
  gazetteerNameFrom,
  homeBand,
  placePhrase,
  relativePhrase,
} from "./place-phrase.ts";

/** The seeded Photos roll (seed.js), which is what both surfaces render. */
const HOME_BACKYARD = { lat: 37.4419, lng: -122.143 };
const WEST_SHORE_RIDGE = { lat: 39.0021, lng: -120.1131 };
const EMERALD_BAY = { lat: 38.9542, lng: -120.1094 };

const HOME: NamedPlace = {
  key: "home",
  name: "Home",
  ...HOME_BACKYARD,
  isHome: true,
};
const RIDGE: NamedPlace = {
  key: "ridge",
  name: "The ridge",
  ...WEST_SHORE_RIDGE,
};

/** The shape every place row wears until a member renames it. */
const COORDINATE_LABEL = /^-?\d{1,3}\.\d+,\s*-?\d{1,3}\.\d+$/u;

describe("the phrase ladder", () => {
  it("prints the member's own name above everything else", () => {
    const phrase = placePhrase({
      placeName: "Grandma's house",
      gazetteerName: "Truckee, CA",
      ...EMERALD_BAY,
      namedPlaces: [HOME],
    });
    expect(phrase).toStrictEqual({ text: "Grandma's house", source: "member" });
  });

  it("falls to the gazetteer when the stored name is just the coordinate", () => {
    const phrase = placePhrase({
      placeName: "38.9542, -120.1094",
      gazetteerName: "Truckee, CA",
      ...EMERALD_BAY,
      namedPlaces: [HOME],
    });
    // "near", because a settlement name is a neighbourhood-scale claim.
    expect(phrase).toStrictEqual({
      text: "near Truckee, CA",
      source: "gazetteer",
    });
  });

  it("falls to a phrase relative to a place the member DID name", () => {
    const phrase = placePhrase({
      placeName: "38.9542, -120.1094",
      ...EMERALD_BAY,
      namedPlaces: [RIDGE],
    });
    expect(phrase).toStrictEqual({
      text: "5.3 km S of The ridge",
      source: "relative",
    });
  });

  it("says so honestly when it has nothing at all", () => {
    expect(placePhrase({ placeName: "38.9542, -120.1094" })).toStrictEqual({
      text: PLACE_NO_NAME,
      source: "none",
    });
    expect(placePhrase({})).toStrictEqual({
      text: PLACE_NO_NAME,
      source: "none",
    });
  });

  it("ignores anchors whose own name is still a coordinate", () => {
    const unnamed: NamedPlace = {
      key: "u",
      name: "39.0021, -120.1131",
      ...WEST_SHORE_RIDGE,
    };
    expect(placePhrase({ ...EMERALD_BAY, namedPlaces: [unnamed] }).source).toBe(
      "none"
    );
  });
});

describe("the coordinate never renders as a name", () => {
  const coordinateShaped = [
    "38.9542, -120.1094",
    "38.9542,-120.1094",
    "  37.4419, -122.1430  ",
    "-33.8688, 151.2093",
  ];

  it("refuses a coordinate-shaped name on every rung", () => {
    for (const name of coordinateShaped) {
      for (const context of ["private", "shared"] as const) {
        for (const namedPlaces of [[], [HOME], [HOME, RIDGE]]) {
          const { text } = placePhrase({
            placeName: name,
            gazetteerName: name,
            ...EMERALD_BAY,
            namedPlaces,
            context,
          });
          expect(text).not.toMatch(COORDINATE_LABEL);
          expect(text).not.toContain(name.trim());
        }
      }
    }
  });

  it("spells the coordinate only when explicitly asked", () => {
    expect(exactLocation(EMERALD_BAY.lat, EMERALD_BAY.lng)).toBe(
      "38.95420, -120.10940"
    );
    expect(exactLocation(null, null)).toBeNull();
    expect(exactLocation(38.9542, undefined)).toBeNull();
    expect(exactLocation(Number.NaN, 1)).toBeNull();
  });
});

describe("shared contexts never leak the way home", () => {
  const input = {
    placeName: "38.9542, -120.1094",
    ...EMERALD_BAY,
    namedPlaces: [RIDGE, HOME],
  };

  it("phrases relative to a named place in private", () => {
    expect(placePhrase({ ...input, context: "private" }).source).toBe(
      "relative"
    );
  });

  it("skips the whole rung when shared, home-anchored or not", () => {
    expect(placePhrase({ ...input, context: "shared" })).toStrictEqual({
      text: PLACE_NO_NAME,
      source: "none",
    });
    // Even standing in the back garden — the rung is gone, not softened.
    expect(
      placePhrase({
        ...HOME_BACKYARD,
        namedPlaces: [HOME],
        context: "shared",
      }).source
    ).toBe("none");
  });

  it("still prints what the member chose to say", () => {
    expect(
      placePhrase({ placeName: "Emerald Bay", context: "shared" }).text
    ).toBe("Emerald Bay");
    expect(
      placePhrase({ gazetteerName: "Truckee, CA", context: "shared" }).text
    ).toBe("near Truckee, CA");
  });
});

describe("distance and bearing over the seeded roll", () => {
  it("measures the lake places against each other", () => {
    const km = distanceKm(
      WEST_SHORE_RIDGE.lat,
      WEST_SHORE_RIDGE.lng,
      EMERALD_BAY.lat,
      EMERALD_BAY.lng
    );
    expect(km).toBeCloseTo(5.336, 2);
    // Emerald Bay is almost due south of the ridge; the ridge due north of it.
    expect(
      compassPoint(
        bearingDegrees(
          WEST_SHORE_RIDGE.lat,
          WEST_SHORE_RIDGE.lng,
          EMERALD_BAY.lat,
          EMERALD_BAY.lng
        )
      )
    ).toBe("S");
    expect(
      compassPoint(
        bearingDegrees(
          EMERALD_BAY.lat,
          EMERALD_BAY.lng,
          WEST_SHORE_RIDGE.lat,
          WEST_SHORE_RIDGE.lng
        )
      )
    ).toBe("N");
  });

  it("puts the lake a long way north-east of home", () => {
    const km = distanceKm(
      HOME_BACKYARD.lat,
      HOME_BACKYARD.lng,
      WEST_SHORE_RIDGE.lat,
      WEST_SHORE_RIDGE.lng
    );
    expect(km).toBeCloseTo(248.06, 1);
    expect(
      placePhrase({ ...WEST_SHORE_RIDGE, namedPlaces: [HOME] })
    ).toStrictEqual({
      text: "248 km NE of Home",
      source: "relative",
    });
  });

  it("drops the bearing when it is standing at the anchor", () => {
    expect(
      placePhrase({ lat: 37.4419, lng: -122.1431, namedPlaces: [HOME] }).text
    ).toBe("At Home");
  });

  it("prefers home as the anchor within a town, the nearest one beyond it", () => {
    // A named place 300m from the back garden. Home still wins: "300 m NE of
    // Home" situates a reader, "100 m S of Shed" does not.
    const shed: NamedPlace = {
      key: "shed",
      name: "Shed",
      lat: 37.4446,
      lng: -122.143,
    };
    expect(
      placePhrase({ lat: 37.4449, lng: -122.143, namedPlaces: [HOME, shed] })
        .text
    ).toBe("350 m N of Home");
    // At the lake, home is 248km away, so the ridge takes over as the anchor.
    expect(
      placePhrase({ ...EMERALD_BAY, namedPlaces: [HOME, RIDGE] }).text
    ).toBe("5.3 km S of The ridge");
  });

  it("refuses to phrase against an anchor that is not a place any more", () => {
    // Sydney, anchored on a Californian home: over the ceiling, so the phrase
    // gives up rather than printing a bearing nobody can use.
    expect(
      placePhrase({ lat: -33.8688, lng: 151.2093, namedPlaces: [HOME] })
    ).toStrictEqual({ text: PLACE_NO_NAME, source: "none" });
  });

  it("returns nothing rather than zero for a coordinate it cannot read", () => {
    expect(distanceKm(Number.NaN, 0, 1, 1)).toBeNaN();
    expect(bearingDegrees(0, 0, Number.NaN, 1)).toBeNaN();
    expect(compassPoint(Number.NaN)).toBeNull();
    expect(relativePhrase(Number.NaN, 0, [HOME])).toBeNull();
    expect(relativePhrase(37.4419, -122.143, [])).toBeNull();
  });
});

describe("the compass", () => {
  it("rounds to eight points, wrapping through north", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(22)).toBe("N");
    expect(compassPoint(23)).toBe("NE");
    expect(compassPoint(90)).toBe("E");
    expect(compassPoint(200)).toBe("S");
    expect(compassPoint(350)).toBe("N");
    expect(compassPoint(365)).toBe("N");
    expect(compassPoint(-45)).toBe("NW");
  });
});

describe("distances in the register a person would use", () => {
  it("uses metres below a kilometre, to the nearest fifty", () => {
    expect(formatDistance(0.34)).toBe("350 m");
    // 990m rounds up to a kilometre rather than printing "1000 m".
    expect(formatDistance(0.999)).toBe("1.0 km");
    expect(formatDistance(0)).toBe("0 m");
  });

  it("uses one decimal up to ten kilometres and whole ones above", () => {
    expect(formatDistance(1)).toBe("1.0 km");
    expect(formatDistance(3.44)).toBe("3.4 km");
    expect(formatDistance(9.99)).toBe("10.0 km");
    expect(formatDistance(10)).toBe("10 km");
    expect(formatDistance(248.06)).toBe("248 km");
  });

  it("has no number for a distance it does not have", () => {
    expect(formatDistance(Number.NaN)).toBeNull();
    expect(formatDistance(-1)).toBeNull();
  });
});

describe("the home band", () => {
  it("calls the garden home and the errands around town", () => {
    expect(homeBand(0)).toBe("at home");
    expect(homeBand(0.5)).toBe("at home");
    expect(homeBand(0.51)).toBe("around town");
    expect(homeBand(25)).toBe("around town");
    expect(homeBand(25.1)).toBe("away");
    expect(homeBand(248.06)).toBe("away");
  });

  it("claims nothing about a distance it does not know", () => {
    expect(homeBand(Number.NaN)).toBeNull();
  });
});

describe("the gazetteer record, read out of address_json", () => {
  it("finds the settlement name the automation wrote", () => {
    expect(
      gazetteerNameFrom(
        JSON.stringify({
          gazetteer: {
            name: "Truckee, CA",
            admin: "CA",
            distance_km: 18.1,
            checked_at: "2026-08-17T00:00:00.000Z",
          },
        })
      )
    ).toBe("Truckee, CA");
  });

  it("ignores every other key in the blob", () => {
    expect(
      gazetteerNameFrom(
        JSON.stringify({
          street: "10 Somewhere Road",
          gazetteer: { name: "Kyoto" },
        })
      )
    ).toBe("Kyoto");
  });

  it("reads a checked-and-found-nothing marker as no name", () => {
    // A miss is a recorded result, not a name. The ladder must fall through to
    // the relative rung rather than print anything about it.
    expect(
      gazetteerNameFrom(
        JSON.stringify({
          gazetteer: { none: true, checked_at: "2026-08-17T00:00:00.000Z" },
        })
      )
    ).toBeNull();
  });

  it("survives every shape of nothing", () => {
    expect(gazetteerNameFrom(null)).toBeNull();
    expect(gazetteerNameFrom(undefined)).toBeNull();
    expect(gazetteerNameFrom("")).toBeNull();
    expect(gazetteerNameFrom("{not json")).toBeNull();
    expect(gazetteerNameFrom("null")).toBeNull();
    expect(gazetteerNameFrom('"a string"')).toBeNull();
    expect(gazetteerNameFrom("{}")).toBeNull();
    expect(gazetteerNameFrom(JSON.stringify({ gazetteer: null }))).toBeNull();
    expect(
      gazetteerNameFrom(JSON.stringify({ gazetteer: "Truckee" }))
    ).toBeNull();
    expect(
      gazetteerNameFrom(JSON.stringify({ gazetteer: { name: 7 } }))
    ).toBeNull();
    expect(
      gazetteerNameFrom(JSON.stringify({ gazetteer: { name: "  " } }))
    ).toBeNull();
  });

  it("feeds rung 2 of the ladder, and loses to a name the member typed", () => {
    const addressJson = JSON.stringify({ gazetteer: { name: "Truckee, CA" } });

    expect(
      placePhrase({ gazetteerName: gazetteerNameFrom(addressJson) })
    ).toStrictEqual({ text: "near Truckee, CA", source: "gazetteer" });
    expect(
      placePhrase({
        placeName: "Grandma's house",
        gazetteerName: gazetteerNameFrom(addressJson),
      })
    ).toStrictEqual({ text: "Grandma's house", source: "member" });
  });
});
