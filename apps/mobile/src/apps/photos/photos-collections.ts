// What Collections is made of — the sections, their covers, and what each says
// when it is empty. Pure: no react, navigation or theme, so every claim is
// assertable without a renderer.
//
// EVERY SECTION IS A SHELF THAT EXISTS: a real filter over the library, with a
// real count, rendered even when empty — an empty section states what would
// appear there and why it has not. A section that comes back empty BY
// CONSTRUCTION is the defect this shape exists to avoid, which is why the old
// "Categories" grid of shelves the vault could not keep was removed.
//
// That is the bar Screenshots, Panoramas and Selfies fail. Selfies has no
// signal at all. Screenshots and Panoramas exist on iOS only, and only through
// a PER-ASSET getter — no bulk field on the shape `timeline-engine.ts`'s walk
// queries — so a shelf for them costs one round trip per photograph across the
// whole library, the regression that walk's header already rejected. Videos
// (#721) qualifies because `PhotoAsset.kind` is bulk and honest.

import type { PhotoAsset } from "./timeline-model";

/** Closed, so a section added without a destination fails to typecheck at the
 *  call site. */
export type CollectionSectionKey =
  | "memories"
  | "albums"
  | "people"
  | "places"
  | "favorites"
  | "videos"
  | "duplicates"
  | "trash";

/** The whole set Collapse All folds. A value, not just a type, and kept beside
 *  the union it enumerates: Home folds the known SHAPE, never whatever a query
 *  happened to return. */
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
  /** For sections whose members are NAMED things; absent for a rail of bare
   *  photographs, where the photograph is the whole label. */
  label?: string;
  /** `undefined` leaves the tile on `--skel`, never a decorative tint. */
  uri?: string;
  /** For the derivative-then-original retry ladder. */
  originalUri?: string;
  /** A person tile is a circle; every other is a rounded square. */
  round?: boolean;
}

export interface CollectionSection {
  key: CollectionSectionKey;
  title: string;
  /** `undefined` where the size is not a count a member would recognise. */
  count?: number;
  /** At most one, and only where the section can perform it from here. */
  action?: string;
  tiles: CollectionTile[];
  /** What would appear here and why it has not. Never "nothing here", which
   *  names no cause and offers no road. */
  empty: string;
}

/** Not a cap on the shelf — the rail scrolls — but on how much of it is worth
 *  building tiles for unasked. */
export const RAIL_LIMIT = 12;

export interface AlbumRow {
  collectionId: string;
  name: string;
  assetIds: readonly string[];
  /** The member's own choice of key photo (#721). `undefined` means no choice
   *  has been made, which `chosenCover` reads exactly that way. */
  coverContentId?: string;
}

export interface PlaceRow {
  placeId: string;
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
  /** Ungrouped: this file groups them by year, which is the actual offer. */
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

/** A shelf's cover is its newest member, the rule the timeline sorts by. */
function cover(assets: readonly PhotoAsset[]): PhotoAsset | undefined {
  let newest: PhotoAsset | undefined;
  for (const asset of assets) {
    // An undated asset can never win "newest", but may still cover a shelf
    // holding nothing else.
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
 * The member's OWN choice first, the newest member otherwise — never the
 * reverse (#721): a rail tile calling `cover()` unconditionally honours "Make
 * key photo" on `AlbumDetail` and silently ignores it everywhere else. `members`
 * is already the LIVE set, so a stale chosen id falls through honestly rather
 * than pinning a tile to a photograph the rail cannot show.
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

/** The same grouping the More sheet's meta reports, so the two cannot disagree
 *  about how many there are. */
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
    // Belt and braces: `onThisDay` already drops undated assets.
    if (asset.deleted || asset.capturedAt === undefined) continue;
    const year = asset.capturedAt.slice(0, 4);
    const group = byYear.get(year);
    if (group) group.push(asset);
    else byYear.set(year, [asset]);
  }
  return [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

/**
 * Every section, in order, always — an empty one renders its own sentence.
 * The ORDER is an argument: Memories first as the only section that changes on
 * its own, then the member's own filing, then standing filters, then
 * housekeeping last, because a library is for looking at, not for tidying.
 */
export function buildCollectionSections(
  facts: CollectionFacts
): CollectionSection[] {
  const live = facts.assets.filter((asset) => !asset.deleted);
  // BOTH ids a photograph answers to: album entries and face regions point at
  // `assetId`, so indexing by `id` alone resolves half of them to nothing.
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
  // Newest-first already, inherited from `live`'s own order.
  const videos = live.filter((asset) => asset.kind === "video");
  const trashed = facts.assets.filter((asset) => asset.deleted);
  const clusters = duplicateClusters(facts.assets);

  return [
    {
      key: "memories",
      title: "Memories",
      // One tile per YEAR: four photographs from one afternoon are one memory.
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
          live.filter((asset) => asset.placeId === place.placeId)
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
      // The one media-type fact this device carries in bulk (#721) — see the
      // header for why Screenshots and Panoramas are not beside it.
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
