import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  clearGazetteerCache,
  gazetteerPresent,
  loadGazetteer,
  nameFor,
  placeName,
} from "./place-name.js";

/** A few real settlements, chosen because the relationships between them are
 *  the ones the ranking has to get right: a big city, a small town 50km away
 *  under it, and a village nobody would name a distant coordinate after. */
const TABLE = [
  "# name\tregion\tlat\tlng\tpopulation",
  "San Francisco\tCalifornia\t37.7749\t-122.4194\t815000",
  "Palo Alto\tCalifornia\t37.4419\t-122.1430\t68000",
  "South Lake Tahoe\tCalifornia\t38.9399\t-119.9772\t21000",
  "Tahoma\tCalifornia\t39.0683\t-120.1266\t1400",
  "",
  "malformed row with no tabs",
  "Broken\tCalifornia\tnot-a-number\t-120\t500",
].join("\n");

function modelsDirWith(table: string): string {
  const dir = tempDirSync("gazetteer-");
  mkdirSync(path.join(dir, "gazetteer"), { recursive: true });
  writeFileSync(path.join(dir, "gazetteer", "places.tsv"), table, "utf8");
  clearGazetteerCache();
  return dir;
}

describe("gazetteer loading", () => {
  afterEach(() => {
    clearGazetteerCache();
  });

  it("is absent until a table is installed", () => {
    const empty = tempDirSync("gazetteer-empty-");
    expect(gazetteerPresent(empty)).toBe(false);
    expect(gazetteerPresent(modelsDirWith(TABLE))).toBe(true);
  });

  it("skips malformed rows rather than failing the whole table", () => {
    // Third-party data with one bad line must not take down a capability
    // that has hundreds of thousands of good ones.
    const rows = loadGazetteer(modelsDirWith(TABLE));
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.name)).not.toContain("Broken");
  });
});

describe("choosing which settlement names a coordinate", () => {
  afterEach(() => {
    clearGazetteerCache();
  });

  const rows = () => loadGazetteer(modelsDirWith(TABLE));

  it("names a coordinate inside a town after that town", () => {
    const hit = nameFor(rows(), 37.4427, -122.1432);
    expect(hit?.name).toBe("Palo Alto");
    expect(hit?.region).toBe("California");
  });

  it("prefers the place you are standing in over the bigger one nearby", () => {
    // Palo Alto is 50km from San Francisco and both reach this far; being
    // essentially on top of the smaller one has to win, or every Bay Area
    // photograph becomes "San Francisco".
    expect(nameFor(rows(), 37.4419, -122.143)?.name).toBe("Palo Alto");
  });

  it("lets a city name the ground around it", () => {
    // ~8km out of San Francisco and nowhere near anything else in the table.
    expect(nameFor(rows(), 37.84, -122.42)?.name).toBe("San Francisco");
  });

  it("does not let a village claim the next valley", () => {
    // 40km from Tahoma (population 1400). A fixed radius would hand this
    // photograph a name from a place nobody standing here can see.
    expect(nameFor(rows(), 39.42, -120.13)).toBeNull();
  });

  it("says nothing about the middle of the ocean", () => {
    expect(nameFor(rows(), -30, -140)).toBeNull();
  });

  it("is most confident dead centre and least at the edge", () => {
    const centre = nameFor(rows(), 37.7749, -122.4194)!;
    const edge = nameFor(rows(), 37.84, -122.42)!;
    expect(centre.confidence).toBeGreaterThan(edge.confidence);
    expect(centre.confidence).toBeLessThanOrEqual(1);
    expect(edge.confidence).toBeGreaterThanOrEqual(0);
  });
});

describe("the place-name wire answer", () => {
  afterEach(() => {
    clearGazetteerCache();
  });

  it("answers the wire shape for a hit", () => {
    const dir = modelsDirWith(TABLE);
    expect(
      placeName({ id: "p1", lat: 37.4419, lng: -122.143 }, dir)
    ).toStrictEqual({
      id: "p1",
      name: "Palo Alto",
      region: "California",
      confidence: expect.any(Number),
    });
  });

  it("answers a null NAME, not an error, when nothing is near", () => {
    // The distinction the gateway depends on: `name: null` stamps and stops
    // asking; an `error` is retried forever.
    const dir = modelsDirWith(TABLE);
    expect(placeName({ id: "p2", lat: -30, lng: -140 }, dir)).toStrictEqual({
      id: "p2",
      name: null,
    });
  });

  it("reports a bad coordinate as that item's own error", () => {
    const dir = modelsDirWith(TABLE);
    const result = placeName({ id: "p3", lat: Number.NaN, lng: -122 }, dir) as {
      id: string;
      error: string;
    };
    expect(result.id).toBe("p3");
    expect(result.error).toContain("finite");
  });

  it("reports a missing gazetteer as an error rather than throwing", () => {
    const empty = tempDirSync("gazetteer-missing-");
    clearGazetteerCache();
    const result = placeName({ id: "p4", lat: 37, lng: -122 }, empty) as {
      error: string;
    };
    expect(result.error).toBeTruthy();
  });
});
