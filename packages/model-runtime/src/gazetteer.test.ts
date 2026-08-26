/*
 * Pinned against the committed data (#816): the Tahoe expectations are computed
 * from the table — moving them is a product change.
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
    // ~18 km up the road — exactly the case the 50 km radius exists for.
    expect(hit?.distanceKm).toBeCloseTo(18.1, 1);
  });

  it("names both lake-shore coordinates after South Lake Tahoe", () => {
    // Tahoe City is NOT in this dataset (pop < 15,000) though nearer on a map.
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
    expect(
      nearestSettlement(SEEDED.truckeeRiver.lat, SEEDED.truckeeRiver.lng, 10)
    ).toBeNull();
    expect(
      nearestSettlement(SEEDED.truckeeRiver.lat, SEEDED.truckeeRiver.lng, 20)
        ?.name
    ).toBe("Truckee");
  });

  it("prints no state code outside the United States", () => {
    // Non-US rows store no admin code; the phrase stays bare.
    const hit = nearestSettlement(35.0116, 135.768);
    expect(hit?.name).toBe("Kyoto");
    expect(hit?.admin).toBe("");
    expect(hit?.country).toBe("JP");
    expect(hit?.displayName).toBe("Kyoto");
  });

  it("works beside the antimeridian, where a longitude window would not", () => {
    // The search windows latitude only — lookups across the line still hit.
    const hit = nearestSettlement(-18.1, 178.44);
    expect(hit?.name).toBe("Suva");
  });

  it("breaks a near-tie toward the settlement more readers would know", () => {
    // On the Reno–Sparks line the recognisable name wins; past the tie band,
    // the arithmetic is left alone — population breaks ties, not distance.
    const nearTie = nearestSettlement(39.5328, -119.7805);
    expect(nearTie?.name).toBe("Reno");
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
