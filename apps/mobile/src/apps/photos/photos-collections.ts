// Collections: every section is a real filter, even when empty. Empty-by-
// construction is a defect. Screenshots/Panoramas/Selfies fail (per-asset
// iOS getters). Videos (#721) qualifies: `PhotoAsset.kind` is bulk.

import type { PhotoAsset } from "./timeline-model";

export type CollectionSectionKey =
  | "memories"
  | "albums"
  | "people"
  | "places"
  | "favorites"
  | "videos"
  | "duplicates"
  | "trash";

/** Collapse All folds this shape — never whatever a query happened to return. */
export const COLLECTION_SECTION_KEYS: readonly CollectionSectionKey[] = [
  "memories",
  "albums",
  "people",
  "places",
  "favorites",
  "videos",
  "duplicates",
  "trash",
];

export interface CollectionTile {
  id: string;
  label?: string;
  /** `undefined` leaves `--skel`, never a decorative tint. */
  uri?: string;
  originalUri?: string;
  round?: boolean;
}

export interface CollectionSection {
  key: CollectionSectionKey;
  title: string;
  count?: number;
  action?: string;
  tiles: CollectionTile[];
  /** What would appear and why it has not. Never "nothing here". */
  empty: string;
}

/** Rail scroll is unbounded; this caps tiles built unasked. */
export const RAIL_LIMIT = 12;

export interface AlbumRow {
  collectionId: string;
  name: string;
  assetIds: readonly string[];
  /** Member's key photo (#721). `undefined` = no choice (`chosenCover`). */
  coverContentId?: string;
}

export interface PlaceRow {
  placeIds: readonly string[];
  key: string;
  name: string;
}

export interface PersonRow {
  partyId: string;
  name: string;
  assetIds: readonly string[];
}

export interface CollectionFacts {
  assets: readonly PhotoAsset[];
  albums: readonly AlbumRow[];
  places: readonly PlaceRow[];
  people: readonly PersonRow[];
  memories: readonly PhotoAsset[];
}

function tileFor(
  asset: PhotoAsset | undefined,
  label?: string
): CollectionTile[] {
  if (!asset) return [];
  return [
    {
      id: asset.id,
      ...(label === undefined ? {} : { label }),
      uri: asset.uri,
      originalUri: asset.originalUri,
    },
  ];
}

function cover(assets: readonly PhotoAsset[]): PhotoAsset | undefined {
  let newest: PhotoAsset | undefined;
  for (const asset of assets) {
    // Undated never wins "newest", but may still cover a shelf of only undated.
    if (asset.capturedAt === undefined) {
      newest ??= asset;
      continue;
    }
    if (
      newest?.capturedAt === undefined ||
      asset.capturedAt > newest.capturedAt
    )
      newest = asset;
  }
  return newest;
}

/**
 * Member's choice first, newest otherwise — never the reverse (#721).
 * `members` is the LIVE set; a stale chosen id falls through.
 */
function chosenCover(
  members: readonly PhotoAsset[],
  coverContentId: string | undefined
): PhotoAsset | undefined {
  const chosen = coverContentId
    ? members.find((asset) => asset.contentId === coverContentId)
    : undefined;
  return chosen ?? cover(members);
}

export function duplicateClusters(
  assets: readonly PhotoAsset[]
): PhotoAsset[][] {
  const byHash = new Map<string, PhotoAsset[]>();
  for (const asset of assets) {
    if (!asset.phash || asset.deleted) continue;
    const group = byHash.get(asset.phash);
    if (group) group.push(asset);
    else byHash.set(asset.phash, [asset]);
  }
  return [...byHash.values()].filter((group) => group.length > 1);
}

function memoriesByYear(
  memories: readonly PhotoAsset[]
): Array<[string, PhotoAsset[]]> {
  const byYear = new Map<string, PhotoAsset[]>();
  for (const asset of memories) {
    if (asset.deleted || asset.capturedAt === undefined) continue;
    const year = asset.capturedAt.slice(0, 4);
    const group = byYear.get(year);
    if (group) group.push(asset);
    else byYear.set(year, [asset]);
  }
  return [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

export function buildCollectionSections(
  facts: CollectionFacts
): CollectionSection[] {
  const live = facts.assets.filter((asset) => !asset.deleted);
  // Index both ids: albums/faces point at `assetId`; `id` alone misses half.
  const byId = new Map<string, PhotoAsset>();
  for (const asset of facts.assets) {
    byId.set(asset.id, asset);
    if (asset.assetId) byId.set(asset.assetId, asset);
  }
  const assetsOf = (ids: readonly string[]): PhotoAsset[] =>
    ids.flatMap((id) => {
      const asset = byId.get(id);
      return asset && !asset.deleted ? [asset] : [];
    });

  const favorites = live.filter((asset) => asset.favorite);
  const videos = live.filter((asset) => asset.kind === "video");
  const trashed = facts.assets.filter((asset) => asset.deleted);
  const clusters = duplicateClusters(facts.assets);

  return [
    {
      key: "memories",
      title: "Memories",
      tiles: memoriesByYear(facts.memories)
        .slice(0, RAIL_LIMIT)
        .flatMap(([year, group]) => tileFor(cover(group), year)),
      empty:
        "A day with an earlier year behind it appears here — your own photographs, on this day.",
    },
    {
      key: "albums",
      title: "Albums",
      count: facts.albums.length,
      action: "Create",
      tiles: facts.albums.slice(0, RAIL_LIMIT).map((album) => {
        const front = chosenCover(
          assetsOf(album.assetIds),
          album.coverContentId
        );
        return {
          id: album.collectionId,
          label: album.name,
          ...(front ? { uri: front.uri, originalUri: front.originalUri } : {}),
        };
      }),
      empty: "Select photographs and add them to an album.",
    },
    {
      key: "people",
      title: "People",
      count: facts.people.length,
      tiles: facts.people.slice(0, RAIL_LIMIT).map((person) => {
        const front = cover(assetsOf(person.assetIds));
        return {
          id: person.partyId,
          label: person.name,
          round: true,
          ...(front ? { uri: front.uri, originalUri: front.originalUri } : {}),
        };
      }),
      empty:
        "Faces are proposed on a photograph you open, and a name is only ever yours to confirm. Nobody is named until you name them.",
    },
    {
      key: "places",
      title: "Places",
      count: facts.places.length,
      tiles: facts.places.slice(0, RAIL_LIMIT).map((place) => {
        const front = cover(
          live.filter(
            (asset) => asset.placeId && place.placeIds.includes(asset.placeId)
          )
        );
        return {
          id: place.key,
          label: place.name,
          ...(front ? { uri: front.uri, originalUri: front.originalUri } : {}),
        };
      }),
      empty:
        "A place appears here when a photograph carries where it was taken.",
    },
    {
      key: "favorites",
      title: "Favorites",
      count: favorites.length,
      tiles: favorites.slice(0, RAIL_LIMIT).map((asset) => ({
        id: asset.id,
        uri: asset.uri,
        originalUri: asset.originalUri,
      })),
      empty: "Photographs you mark with a heart collect here.",
    },
    {
      key: "videos",
      title: "Videos",
      count: videos.length,
      tiles: videos.slice(0, RAIL_LIMIT).map((asset) => ({
        id: asset.id,
        uri: asset.uri,
        originalUri: asset.originalUri,
      })),
      empty: "Videos you capture or import collect here.",
    },
    {
      key: "duplicates",
      title: "Duplicates",
      count: clusters.length,
      tiles: clusters
        .slice(0, RAIL_LIMIT)
        .flatMap((group) => tileFor(cover(group))),
      empty:
        "Photographs that look like each other are grouped here for you to decide about.",
    },
    {
      key: "trash",
      title: "Trash",
      count: trashed.length,
      tiles: trashed.slice(0, RAIL_LIMIT).map((asset) => ({
        id: asset.id,
        uri: asset.uri,
        originalUri: asset.originalUri,
      })),
      empty:
        "Deleted photographs wait here for 30 days before they are purged.",
    },
  ];
}
