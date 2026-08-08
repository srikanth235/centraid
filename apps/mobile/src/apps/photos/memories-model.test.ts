import { describe, expect, test } from "vitest";

import {
  buildMemoriesModel,
  buildOnThisDayMemory,
  buildSimilarMemories,
  buildTripMemories,
  hasNoMemories,
  indexAssetsById,
  tripDateLabel,
  yearsAgo,
} from "./memories-model";
import type {
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
    const paris1 = photo("paris1", { capturedAt: "2026-01-05T09:00:00.000Z" });
    const paris2 = photo("paris2", { capturedAt: "2026-01-06T09:00:00.000Z" });
    const rome1 = photo("rome1", { capturedAt: "2025-03-01T09:00:00.000Z" });
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
    const places = new Map([
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
        trips: [
          {
            memoryId: "trip:x",
            placeId: null,
            placeName: null,
            titleHint: null,
            startedAt: null,
            endedAt: null,
            assets: [],
          },
        ],
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
      new Map([["paris", "Paris"]]),
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
    const trip: TripMemory = {
      memoryId: "trip:x",
      placeId: null,
      placeName: null,
      titleHint: "3-day trip",
      startedAt: "2026-01-05T09:00:00.000Z",
      endedAt: "2026-01-08T09:00:00.000Z",
      assets: [],
    };
    expect(tripDateLabel(trip)).toBe("Jan 5 – Jan 8, 2026");
  });

  test("falls back to the title hint when either endpoint is missing", () => {
    const trip: TripMemory = {
      memoryId: "trip:x",
      placeId: null,
      placeName: null,
      titleHint: "3-day trip",
      startedAt: null,
      endedAt: "2026-01-08T09:00:00.000Z",
      assets: [],
    };
    expect(tripDateLabel(trip)).toBe("3-day trip");
  });
});

describe(yearsAgo, () => {
  test("computes the year gap against now", () => {
    expect(yearsAgo("2020", new Date("2026-01-01T00:00:00Z"))).toBe(6);
  });
});
