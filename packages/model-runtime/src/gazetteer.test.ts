/*
 * The bundled gazetteer, pinned against the data actually committed (#816).
 *
 * The Tahoe expectations below are the real answers for the seeded roll's
 * coordinates, computed from the committed table rather than guessed at: they
 * are what a member will see, so a regeneration of the dataset that moves them
 * is a product change and has to be read as one.
 */
import { describe, expect, it } from "vitest";

import {
  GAZETTEER_MAX_KM,
  GAZETTEER_ROW_COUNT,
  GAZETTEER_SNAPSHOT,
  GAZETTEER_SOURCE,
  gazetteerDisplayName,
  gazetteerSize,
  nearestSettlement,
} from "./gazetteer.js";

/** The seeded Photos roll's places (`docs/photos/`), verbatim. */
const SEEDED = {
  westShore: { lat: 39.0021, lng: -120.1131 },
  emeraldBay: { lat: 38.9542, lng: -120.1094 },
  truckeeRiver: { lat: 39.1682, lng: -120.1429 },
  paloAlto: { lat: 37.4419, lng: -122.143 },
} as const;

describe("bundled gazetteer table", () => {
  it("loads every committed row", () => {
    expect(gazetteerSize()).toBe(GAZETTEER_ROW_COUNT);
    expect(GAZETTEER_ROW_COUNT).toBe(23_527);
  });

  it("declares the snapshot the licence file names", () => {
    expect(GAZETTEER_SNAPSHOT).toBe("2017-02-27");
    expect(GAZETTEER_SOURCE).toBe("geonames-cities15000");
  });

  it("accepts a settlement up to fifty kilometres away", () => {
    expect(GAZETTEER_MAX_KM).toBe(50);
  });
});

describe("finding the nearest settlement", () => {
  it("names the Truckee river bend after Truckee", () => {
    const hit = nearestSettlement(
      SEEDED.truckeeRiver.lat,
      SEEDED.truckeeRiver.lng
    );
    expect(hit?.name).toBe("Truckee");
    expect(hit?.admin).toBe("CA");
    expect(hit?.country).toBe("US");
    expect(hit?.displayName).toBe("Truckee, CA");
    // ~18 km up the road, which is exactly the case the 50 km radius exists
    // for: nobody would call the river bend a town, and everybody who drove
    // there would call it near Truckee.
    expect(hit?.distanceKm).toBeCloseTo(18.1, 1);
  });

  it("names both lake-shore coordinates after South Lake Tahoe", () => {
    // Tahoe City is NOT in this dataset — its population is under 15,000 — so
    // South Lake Tahoe (pop. ~21k) is the nearest settlement to the west shore
    // even though Tahoe City is nearer on a map. That is a limit of a
    // 15,000-person table, stated here rather than discovered later.
    const west = nearestSettlement(SEEDED.westShore.lat, SEEDED.westShore.lng);
    expect(west?.displayName).toBe("South Lake Tahoe, CA");
    expect(west?.distanceKm).toBeCloseTo(13.6, 1);

    const bay = nearestSettlement(SEEDED.emeraldBay.lat, SEEDED.emeraldBay.lng);
    expect(bay?.displayName).toBe("South Lake Tahoe, CA");
    expect(bay?.distanceKm).toBeCloseTo(11.1, 1);
  });

  it("names a backyard after the town it is in", () => {
    const hit = nearestSettlement(SEEDED.paloAlto.lat, SEEDED.paloAlto.lng);
    expect(hit?.displayName).toBe("Palo Alto, CA");
    expect(hit?.distanceKm).toBeLessThan(1);
  });

  it("returns nothing in the middle of the Pacific", () => {
    expect(nearestSettlement(-30, -140)).toBeNull();
  });

  it("returns nothing for a coordinate that is not a number", () => {
    expect(nearestSettlement(Number.NaN, -120)).toBeNull();
    expect(nearestSettlement(39, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("honours a tighter radius than the default", () => {
    // Truckee is 18 km from the river bend, so a 10 km radius must decline.
    expect(
      nearestSettlement(SEEDED.truckeeRiver.lat, SEEDED.truckeeRiver.lng, 10)
    ).toBeNull();
    expect(
      nearestSettlement(SEEDED.truckeeRiver.lat, SEEDED.truckeeRiver.lng, 20)
        ?.name
    ).toBe("Truckee");
  });

  it("prints no state code outside the United States", () => {
    // Kyoto: the dataset stores no admin code for a non-US row, and the phrase
    // is the bare settlement name rather than "Kyoto, 22".
    const hit = nearestSettlement(35.0116, 135.768);
    expect(hit?.name).toBe("Kyoto");
    expect(hit?.admin).toBe("");
    expect(hit?.country).toBe("JP");
    expect(hit?.displayName).toBe("Kyoto");
  });

  it("works beside the antimeridian, where a longitude window would not", () => {
    // Suva sits at 178.4°E. A lookup from just across the line at 179.9°E must
    // still find things: the search windows latitude only, for this reason.
    const hit = nearestSettlement(-18.1, 178.44);
    expect(hit?.name).toBe("Suva");
  });

  it("breaks a near-tie toward the settlement more readers would know", () => {
    // Reno (pop. ~225k) and Sparks (~90k) sit 5.3 km apart. On the line between
    // them, 0.52 km nearer Sparks, the two are equidistant as far as a phrase
    // is concerned and the recognisable name wins.
    const nearTie = nearestSettlement(39.5328, -119.7805);
    expect(nearTie?.name).toBe("Reno");
    // Genuinely nearer Sparks — 2.1 km, past the tie band — and the arithmetic
    // is left alone. Population breaks ties; it does not outrank distance.
    const clearlySparks = nearestSettlement(39.5335, -119.7713);
    expect(clearlySparks?.name).toBe("Sparks");
  });

  it("is a pure function of the coordinate", () => {
    const first = nearestSettlement(39.1682, -120.1429);
    const second = nearestSettlement(39.1682, -120.1429);
    expect(second).toStrictEqual(first);
  });
});

describe("what a surface prints", () => {
  it("qualifies with a state code when there is one", () => {
    expect(gazetteerDisplayName({ name: "Truckee", admin: "CA" })).toBe(
      "Truckee, CA"
    );
  });

  it("prints the bare name when there is not", () => {
    expect(gazetteerDisplayName({ name: "Kyoto", admin: "" })).toBe("Kyoto");
  });
});
