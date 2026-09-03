import { describe, expect, it } from "vitest";

import {
  COLLECTION_SECTION_KEYS,
  buildCollectionSections,
} from "./photos-collections";
import type { AlbumRow, CollectionFacts } from "./photos-collections";
import type { PhotoAsset } from "./timeline-model";

function asset(id: string, over: Partial<PhotoAsset> = {}): PhotoAsset {
  return {
    archived: false,
    assetId: `asset-${id}`,
    backupState: "backed-up",
    capturedAt: "2026-07-30T10:00:00.000Z",
    contentId: `content-${id}`,
    deleted: false,
    favorite: false,
    id,
    kind: "photo",
    originalUri: `original-${id}`,
    previewUri: "",
    source: "replica",
    uri: `uri-${id}`,
    ...over,
  };
}

function facts(over: Partial<CollectionFacts> = {}): CollectionFacts {
  return {
    albums: [],
    assets: [],
    memories: [],
    people: [],
    places: [],
    ...over,
  };
}

describe("buildCollectionSections — every section, always, in order", () => {
  it("returns exactly COLLECTION_SECTION_KEYS, in that order", () => {
    const sections = buildCollectionSections(facts());
    expect(sections.map((section) => section.key)).toStrictEqual([
      ...COLLECTION_SECTION_KEYS,
    ]);
  });

  it("uses the rounded shelf key for a place tile, not its raw place id", () => {
    const sections = buildCollectionSections(
      facts({
        places: [
          {
            placeIds: ["raw-place-id"],
            key: "39.1:-120.0",
            name: "Lake Tahoe",
          },
        ],
      })
    );
    const places = sections.find((section) => section.key === "places")!;
    expect(places.tiles[0]).toMatchObject({
      id: "39.1:-120.0",
      label: "Lake Tahoe",
    });
  });

  it("covers a cell from any of its place rows, not just the first", () => {
    const other = asset("other", { placeId: "second-place-id" });
    const sections = buildCollectionSections(
      facts({
        assets: [other],
        places: [
          {
            placeIds: ["first-place-id", "second-place-id"],
            key: "39.1:-120.0",
            name: "Lake Tahoe",
          },
        ],
      })
    );
    const places = sections.find((section) => section.key === "places")!;
    expect(places.tiles[0]).toMatchObject({ uri: "uri-other" });
  });
});

describe("buildCollectionSections — album covers honor the member's choice (issue #721 B5)", () => {
  const older = asset("older", { capturedAt: "2020-01-01T00:00:00.000Z" });
  const newer = asset("newer", { capturedAt: "2026-01-01T00:00:00.000Z" });

  function albumRow(over: Partial<AlbumRow> = {}): AlbumRow {
    return {
      assetIds: ["asset-older", "asset-newer"],
      collectionId: "album-1",
      name: "The coast road",
      ...over,
    };
  }

  it("falls back to the newest member when nobody has chosen a cover", () => {
    const sections = buildCollectionSections(
      facts({ albums: [albumRow()], assets: [older, newer] })
    );
    const albums = sections.find((section) => section.key === "albums")!;
    expect(albums.tiles[0]).toMatchObject({ uri: newer.uri });
  });

  it("prefers the member's chosen cover over the newest member", () => {
    const sections = buildCollectionSections(
      facts({
        albums: [albumRow({ coverContentId: older.contentId })],
        assets: [older, newer],
      })
    );
    const albums = sections.find((section) => section.key === "albums")!;
    expect(albums.tiles[0]).toMatchObject({ uri: older.uri });
  });

  it("falls back to the newest member when the chosen cover is no longer a live member", () => {
    const trashedCover = asset("gone", {
      capturedAt: "2025-01-01T00:00:00.000Z",
      contentId: "content-gone",
      deleted: true,
    });
    const sections = buildCollectionSections(
      facts({
        albums: [
          albumRow({
            assetIds: ["asset-older", "asset-newer"],
            coverContentId: "content-gone",
          }),
        ],
        assets: [older, newer, trashedCover],
      })
    );
    const albums = sections.find((section) => section.key === "albums")!;
    expect(albums.tiles[0]).toMatchObject({ uri: newer.uri });
  });
});

describe("buildCollectionSections — Videos (issue #721 B3)", () => {
  it("states honestly that nothing is here yet, and why", () => {
    const sections = buildCollectionSections(facts());
    const videos = sections.find((section) => section.key === "videos")!;
    expect(videos.count).toBe(0);
    expect(videos.tiles).toStrictEqual([]);
    expect(videos.empty).toMatch(/collect here/u);
  });

  it('carries only kind === "video" assets, never photos or trashed videos', () => {
    const photo = asset("p1", { kind: "photo" });
    const video = asset("v1", { kind: "video" });
    const trashedVideo = asset("v2", { deleted: true, kind: "video" });
    const sections = buildCollectionSections(
      facts({ assets: [photo, video, trashedVideo] })
    );
    const videos = sections.find((section) => section.key === "videos")!;
    expect(videos.count).toBe(1);
    expect(videos.tiles.map((tile) => tile.id)).toStrictEqual(["v1"]);
  });

  it("sits between Favorites and Duplicates — a standing filter, not member filing", () => {
    const keys = [...COLLECTION_SECTION_KEYS];
    expect(keys.indexOf("videos")).toBe(keys.indexOf("favorites") + 1);
    expect(keys.indexOf("duplicates")).toBe(keys.indexOf("videos") + 1);
  });
});
