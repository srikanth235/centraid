import { describe, expect, test } from "vitest";

import {
  buildMemoriesModel,
  buildOnThisDayMemory,
  buildSimilarMemories,
  buildTripMemories,
  hasNoMemories,
  homePlaceKey,
  indexAssetsById,
  memoryPlacesById,
  tripDateLabel,
  yearsAgo,
} from "./memories-model";
import type {
  MemoryPlace,
  RawMemoryMemberRow,
  RawMemoryRow,
  TripMemory,
} from "./memories-model";
import type { PhotoAsset } from "./timeline-model";

const photo = (id: string, fields: Partial<PhotoAsset> = {}): PhotoAsset => ({
  id,
  assetId: id,
  uri: id,
  previewUri: id,
  originalUri: id,
  capturedAt: "2025-07-16T10:00:00.000Z",
  kind: "photo",
  favorite: false,
  archived: false,
  deleted: false,
  backupState: "local-only",
  source: "replica",
  ...fields,
});

function memoryRow(fields: Partial<RawMemoryRow> = {}): RawMemoryRow {
  return {
    memory_id: "m1",
    kind: "on-this-day",
    title_hint: null,
    day_key: null,
    place_id: null,
    started_at: null,
    ended_at: null,
    ...fields,
  };
}

function memberRow(
  memoryId: string,
  assetId: string,
  ordinal: number
): RawMemoryMemberRow {
  return { memory_id: memoryId, asset_id: assetId, ordinal };
}

/** A place map of names only. A trip's title needs the whole row (issue #816),
 *  so this shorthand keeps the cases that do not need one readable. */
const namedPlaces = (
  entries: readonly (readonly [string, string])[]
): Map<string, MemoryPlace> =>
  new Map(entries.map(([key, name]) => [key, { key, name }]));

/** The trip fields `TripMemory` grew with the phrase ladder (issue #816), so a
 *  fixture asserting the older ones does not have to restate them. */
const tripFixture = (over: Partial<TripMemory> = {}): TripMemory => ({
  memoryId: "trip:x",
  placeId: null,
  placeName: null,
  titleHint: null,
  title: "Away from home",
  route: [],
  startedAt: null,
  endedAt: null,
  assets: [],
  ...over,
});

describe(buildOnThisDayMemory, () => {
  test("null when there is no row for today's month-day", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const rows = [memoryRow({ memory_id: "otd:01-01", day_key: "01-01" })];
    const result = buildOnThisDayMemory(rows, [], indexAssetsById([]), now);
    expect(result).toBeNull();
  });

  test("null when every member is this exact calendar year", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const rows = [memoryRow({ memory_id: "otd:07-16", day_key: "07-16" })];
    const today = photo("today", { capturedAt: "2026-07-16T09:00:00.000Z" });
    const members = [memberRow("otd:07-16", "today", 0)];
    const result = buildOnThisDayMemory(
      rows,
      members,
      indexAssetsById([today]),
      now
    );
    expect(result).toBeNull();
  });

  test("groups prior-year members by year, newest year first, excluding this year", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const rows = [memoryRow({ memory_id: "otd:07-16", day_key: "07-16" })];
    const y2024 = photo("y2024", { capturedAt: "2024-07-16T09:00:00.000Z" });
    const y2023 = photo("y2023", { capturedAt: "2023-07-16T09:00:00.000Z" });
    const thisYear = photo("this-year", {
      capturedAt: "2026-07-16T09:00:00.000Z",
    });
    const members = [
      memberRow("otd:07-16", "y2024", 0),
      memberRow("otd:07-16", "y2023", 1),
      memberRow("otd:07-16", "this-year", 2),
    ];
    const result = buildOnThisDayMemory(
      rows,
      members,
      indexAssetsById([y2024, y2023, thisYear]),
      now
    );
    expect(result?.years.map((group) => group.year)).toStrictEqual([
      "2024",
      "2023",
    ]);
    expect(result?.years[0]?.assets.map((asset) => asset.id)).toStrictEqual([
      "y2024",
    ]);
  });

  test("a deleted member drops out of the group", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const rows = [memoryRow({ memory_id: "otd:07-16", day_key: "07-16" })];
    const trashed = photo("trashed", {
      capturedAt: "2024-07-16T09:00:00.000Z",
      deleted: true,
    });
    const members = [memberRow("otd:07-16", "trashed", 0)];
    const result = buildOnThisDayMemory(
      rows,
      members,
      indexAssetsById([trashed]),
      now
    );
    expect(result).toBeNull();
  });
});

describe(buildTripMemories, () => {
  test("resolves a trip's assets and place name, newest trip first", () => {
    // The members carry their place, because a trip's name is now read off
    // the places its own photographs were taken at (issue #816) rather than
    // off a name looked up from the row's place_id — a row can name a place
    // nothing in the trip was actually shot at.
    const paris1 = photo("paris1", {
      capturedAt: "2026-01-05T09:00:00.000Z",
      placeId: "paris",
    });
    const paris2 = photo("paris2", {
      capturedAt: "2026-01-06T09:00:00.000Z",
      placeId: "paris",
    });
    const rome1 = photo("rome1", {
      capturedAt: "2025-03-01T09:00:00.000Z",
      placeId: "rome",
    });
    const rows: RawMemoryRow[] = [
      memoryRow({
        memory_id: "trip:2026-01-05",
        kind: "trip",
        place_id: "paris",
        title_hint: "2-day trip",
        started_at: "2026-01-05T09:00:00.000Z",
        ended_at: "2026-01-06T09:00:00.000Z",
      }),
      memoryRow({
        memory_id: "trip:2025-03-01",
        kind: "trip",
        place_id: "rome",
        title_hint: "1-day trip",
        started_at: "2025-03-01T09:00:00.000Z",
        ended_at: "2025-03-01T09:00:00.000Z",
      }),
    ];
    const members = [
      memberRow("trip:2026-01-05", "paris1", 0),
      memberRow("trip:2026-01-05", "paris2", 1),
      memberRow("trip:2025-03-01", "rome1", 0),
    ];
    const places = namedPlaces([
      ["paris", "Paris"],
      ["rome", "Rome"],
    ]);
    const trips = buildTripMemories(
      rows,
      members,
      indexAssetsById([paris1, paris2, rome1]),
      places
    );
    expect(trips.map((trip) => trip.memoryId)).toStrictEqual([
      "trip:2026-01-05",
      "trip:2025-03-01",
    ]);
    expect(trips[0]?.placeName).toBe("Paris");
    expect(trips[0]?.title).toBe("2 days in Paris");
    expect(trips[0]?.assets.map((asset) => asset.id)).toStrictEqual([
      "paris1",
      "paris2",
    ]);
  });

  test("a trip whose place is unresolved still renders, with a null name", () => {
    const asset = photo("a1");
    const rows = [
      memoryRow({
        memory_id: "trip:x",
        kind: "trip",
        place_id: "unknown-place",
      }),
    ];
    const trips = buildTripMemories(
      rows,
      [memberRow("trip:x", "a1", 0)],
      indexAssetsById([asset]),
      new Map()
    );
    expect(trips[0]?.placeName).toBeNull();
  });

  test("a trip with no resolvable members is dropped entirely", () => {
    const rows = [memoryRow({ memory_id: "trip:gone", kind: "trip" })];
    const trips = buildTripMemories(
      rows,
      [memberRow("trip:gone", "never-synced", 0)],
      indexAssetsById([]),
      new Map()
    );
    expect(trips).toStrictEqual([]);
  });
});

describe(buildSimilarMemories, () => {
  test("resolves a similar-moment group's live members", () => {
    const a = photo("a");
    const b = photo("b");
    const rows = [memoryRow({ memory_id: "similar:a", kind: "similar" })];
    const members = [
      memberRow("similar:a", "a", 0),
      memberRow("similar:a", "b", 1),
    ];
    const groups = buildSimilarMemories(rows, members, indexAssetsById([a, b]));
    expect(groups).toHaveLength(1);
    expect(groups[0]?.assets.map((asset) => asset.id)).toStrictEqual([
      "a",
      "b",
    ]);
  });

  test("drops a similar group with no live resolvable members", () => {
    const rows = [memoryRow({ memory_id: "similar:gone", kind: "similar" })];
    const groups = buildSimilarMemories(
      rows,
      [memberRow("similar:gone", "missing", 0)],
      indexAssetsById([])
    );
    expect(groups).toStrictEqual([]);
  });
});

describe(hasNoMemories, () => {
  test("true when every section is empty", () => {
    expect(hasNoMemories({ onThisDay: null, trips: [], similar: [] })).toBe(
      true
    );
  });

  test("false when any section has content", () => {
    expect(
      hasNoMemories({
        onThisDay: null,
        trips: [tripFixture()],
        similar: [],
      })
    ).toBe(false);
  });
});

describe(buildMemoriesModel, () => {
  test("builds all three sections from the same raw rows in one pass", () => {
    const now = new Date("2026-07-16T12:00:00Z");
    const otd = photo("otd-2024", { capturedAt: "2024-07-16T09:00:00.000Z" });
    const tripAsset = photo("trip-a", {
      capturedAt: "2026-01-05T09:00:00.000Z",
    });
    const similarAsset1 = photo("sim-a");
    const similarAsset2 = photo("sim-b");
    const rows: RawMemoryRow[] = [
      memoryRow({
        memory_id: "otd:07-16",
        kind: "on-this-day",
        day_key: "07-16",
      }),
      memoryRow({
        memory_id: "trip:2026-01-05",
        kind: "trip",
        place_id: "paris",
      }),
      memoryRow({ memory_id: "similar:sim-a", kind: "similar" }),
    ];
    const members = [
      memberRow("otd:07-16", "otd-2024", 0),
      memberRow("trip:2026-01-05", "trip-a", 0),
      memberRow("similar:sim-a", "sim-a", 0),
      memberRow("similar:sim-a", "sim-b", 1),
    ];
    const model = buildMemoriesModel(
      rows,
      members,
      [otd, tripAsset, similarAsset1, similarAsset2],
      namedPlaces([["paris", "Paris"]]),
      now
    );
    expect(model.onThisDay?.years.map((y) => y.year)).toStrictEqual(["2024"]);
    expect(model.trips).toHaveLength(1);
    expect(model.similar).toHaveLength(1);
    expect(hasNoMemories(model)).toBe(false);
  });
});

describe(tripDateLabel, () => {
  test("formats a date range across the same year", () => {
    const trip = tripFixture({
      titleHint: "3-day trip",
      startedAt: "2026-01-05T09:00:00.000Z",
      endedAt: "2026-01-08T09:00:00.000Z",
    });
    expect(tripDateLabel(trip)).toBe("Jan 5 – Jan 8, 2026");
  });

  test("falls back to the title hint when either endpoint is missing", () => {
    const trip = tripFixture({
      titleHint: "3-day trip",
      endedAt: "2026-01-08T09:00:00.000Z",
    });
    expect(tripDateLabel(trip)).toBe("3-day trip");
  });
});

describe(yearsAgo, () => {
  test("computes the year gap against now", () => {
    expect(yearsAgo("2020", new Date("2026-01-01T00:00:00Z"))).toBe(6);
  });
});

// ── A trip, named and sketched (issue #816) ────────────────────────────────
//
// `trips.test.ts` in the blueprints package owns the title grammar and the
// route arithmetic — both surfaces call the same function, so restating them
// here would only assert that the import works. What these cases own is the
// phone's own wiring: reading the place ROW (name, gazetteer, coordinates)
// instead of a name map, and resolving home over the whole library rather than
// over one trip's members, which is the mistake that makes every away day read
// as a day at home.

const PLACE_ROWS = [
  {
    place_id: "place-home",
    name: "Home",
    kind: "home",
    geo_lat: 37.44,
    geo_lng: -122.14,
  },
  {
    place_id: "place-tahoe",
    // What `findOrCreatePlaceTx` mints and nobody renamed — the label a title
    // must never print.
    name: "39.09680, -120.03240",
    address_json: JSON.stringify({
      gazetteer: { name: "South Lake Tahoe, CA" },
    }),
    geo_lat: 39.0968,
    geo_lng: -120.0324,
  },
  {
    place_id: "place-truckee",
    name: "39.32800, -120.18330",
    address_json: JSON.stringify({ gazetteer: { name: "Truckee, CA" } }),
    geo_lat: 39.328,
    geo_lng: -120.1833,
  },
];

describe(memoryPlacesById, () => {
  test("reads a place's name, its gazetteer name and its coordinates", () => {
    const places = memoryPlacesById(PLACE_ROWS);
    expect(places.get("place-tahoe")).toStrictEqual({
      key: "place-tahoe",
      name: "39.09680, -120.03240",
      gazetteer: "South Lake Tahoe, CA",
      lat: 39.0968,
      lng: -120.0324,
      isHome: false,
    });
    expect(places.get("place-home")?.isHome).toBe(true);
    expect(places.get("place-home")?.gazetteer).toBeNull();
  });
});

describe(homePlaceKey, () => {
  test("takes the tagged home place over the library's modal place", () => {
    const places = memoryPlacesById(PLACE_ROWS);
    const library = [
      photo("t1", { placeId: "place-tahoe" }),
      photo("t2", { placeId: "place-tahoe" }),
      photo("h1", { placeId: "place-home" }),
    ];
    expect(homePlaceKey(library, places)).toBe("place-home");
  });

  test("falls back to the modal place when no row is tagged home", () => {
    const places = memoryPlacesById(
      PLACE_ROWS.map((row) =>
        row.place_id === "place-home" ? { ...row, kind: null } : row
      )
    );
    const library = [
      photo("h1", { placeId: "place-home" }),
      photo("h2", { placeId: "place-home" }),
      photo("t1", { placeId: "place-tahoe" }),
    ];
    expect(homePlaceKey(library, places)).toBe("place-home");
  });
});

describe("a trip block's heading", () => {
  const TAHOE_TRIP = memoryRow({
    memory_id: "trip:2026-08-15",
    kind: "trip",
    place_id: "place-tahoe",
    title_hint: "2-day trip",
    started_at: "2026-08-15T09:00:00.000Z",
    ended_at: "2026-08-16T20:00:00.000Z",
  });

  /** The seeded roll's shape: a stop in Truckee on the way to a Saturday and
   *  a Sunday at the lake, plus a frame indoors that carries no place. */
  const TRIP_ASSETS = [
    photo("truckee-1", {
      placeId: "place-truckee",
      capturedAt: "2026-08-15T09:00:00.000Z",
    }),
    photo("tahoe-1", {
      placeId: "place-tahoe",
      capturedAt: "2026-08-15T14:00:00.000Z",
    }),
    photo("tahoe-2", {
      placeId: "place-tahoe",
      capturedAt: "2026-08-16T11:00:00.000Z",
    }),
    photo("indoors", { capturedAt: "2026-08-16T20:00:00.000Z" }),
  ];

  const trip = (): TripMemory =>
    buildTripMemories(
      [TAHOE_TRIP],
      TRIP_ASSETS.map((asset, ordinal) =>
        memberRow("trip:2026-08-15", asset.id, ordinal)
      ),
      indexAssetsById(TRIP_ASSETS),
      memoryPlacesById(PLACE_ROWS),
      "place-home"
    )[0]!;

  test("reads the ladder's sentence, not the vault's day count", () => {
    expect(trip().title).toBe("Weekend in South Lake Tahoe, CA");
    expect(trip().titleHint).toBe("2-day trip");
  });

  test("prints no coordinate and no bearing from home", () => {
    const { title } = trip();
    expect(title).not.toMatch(/\d\.\d/u);
    expect(title).not.toContain("Home");
  });

  test("carries the trip's stops in capture order for the sketch", () => {
    expect(trip().route.map((point) => point.key)).toStrictEqual([
      "place-truckee",
      "place-tahoe",
    ]);
    expect(trip().route.map((point) => point.count)).toStrictEqual([1, 2]);
  });

  test("keeps the unplaced frame in the trip and out of the route", () => {
    expect(trip().assets.map((asset) => asset.id)).toContain("indoors");
    expect(trip().route).toHaveLength(2);
  });

  test("falls back to the vault's hint when no stop can be named", () => {
    const unnamed = PLACE_ROWS.map((row) =>
      row.place_id === "place-home" ? row : { ...row, address_json: null }
    );
    const trips = buildTripMemories(
      [TAHOE_TRIP],
      TRIP_ASSETS.map((asset, ordinal) =>
        memberRow("trip:2026-08-15", asset.id, ordinal)
      ),
      indexAssetsById(TRIP_ASSETS),
      memoryPlacesById(unnamed),
      "place-home"
    );
    expect(trips[0]?.title).toBe("2-day trip");
    // Still sketchable: a stop with no name still has a coordinate.
    expect(trips[0]?.route).toHaveLength(2);
  });
});
