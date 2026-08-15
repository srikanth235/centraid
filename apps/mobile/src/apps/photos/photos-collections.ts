// What Collections is made of — the sections, their covers, and what each one
// says when it is empty.
//
// Pure. No react, no navigation, no theme: every claim this file makes about a
// member's library is a function of rows that are already loaded, so it can be
// asserted directly rather than through a renderer.
//
// THE SHAPE, and where it comes from. iOS Photos' Collections page is a stack
// of named sections, each a horizontal rail of cover tiles, each rendered even
// when it holds nothing — an empty section states what would appear there and
// why it has not. That last part is why the shape is worth copying: it is the
// same argument this product already makes about counts and refusals, which is
// that a member should be able to learn the shape of their own library from
// looking at it, including the parts of it that are still empty.
//
// WHAT IT IS NOT. Every section here is a shelf that EXISTS — a real filter
// over the library, reachable, with a real count. The screen this replaces
// once carried a six-tile "Categories" grid (Documents, Selfies, Food, …)
// standing for shelves this product does not have; those were removed for
// promising what the vault could not keep, and nothing here reintroduces one.
// If a section is empty, that is a fact about the member's library, never a
// placeholder for a feature.
//
// VIDEOS (issue #721 B3) joined this list because `PhotoAsset.kind ===
// "video"` is an honest fact this device already carries — no different from
// Favorites' `asset.favorite`. Screenshots and Panoramas did NOT, and Selfies
// still has not, and the three are deferred for two different reasons worth
// keeping straight:
//
//   Selfies has no signal at all — front-camera capture is not recorded
//   anywhere this app reads.
//
//   Screenshots and Panoramas DO exist as a real, named iOS concept
//   (`PHAssetMediaSubtype.screenshot` / `.panorama`, surfaced by
//   expo-media-library as `Asset#getMediaSubtypes()`), but that getter is
//   PER-ASSET and iOS-only — there is no bulk field for it on the
//   `AssetField`/`AssetMetadata` shape the device walk actually queries
//   (`timeline-engine.ts`'s `Query#exeForMetadata()`). Calling it once per
//   photograph across a fifty-thousand-photo library is the exact regression
//   that walk's own header comment already rejected for ordinary EXIF fields
//   ("350k round-trips instead of ~50"), and Android has no subtype concept
//   to report even if the round-trip cost were paid. Until the platform
//   offers a bulk answer (or this product accepts eating that cost for a
//   bounded slice, e.g. only newly-imported assets), a Screenshots or
//   Panoramas shelf here would be exactly the "sometimes comes back empty by
//   construction" shelf this file's own argument above rejects — so, like
//   Selfies, they stay out rather than ship dishonest.

import type { PhotoAsset } from "./timeline-model";

/** Closed union so the view's router can switch exhaustively — a section
 *  added here without a destination fails to typecheck at the call site. */
export type CollectionSectionKey =
  | "memories"
  | "albums"
  | "people"
  | "places"
  | "favorites"
  | "videos"
  | "duplicates"
  | "trash";

/** The fixed, argued order (see the file header) as a value rather than only
 *  a type — `buildCollectionSections` always returns exactly these eight
 *  sections ("AN EMPTY SECTION STILL RENDERS", above), so this is the whole
 *  set Collapse All needs to fold every shelf at once. It lives here, next to
 *  the union it enumerates, rather than in `PhotosHome.tsx` (issue #712: the
 *  header chip that opens Collapse All moved there, but the replica queries
 *  the actual `sections` array is built from stayed in
 *  `PhotosCollectionsView.tsx` — Home folds the whole known shape, not
 *  whatever a query happened to return). */
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
  /** Burned into the tile's lower-left corner, iOS-style, for the sections
   *  whose members are NAMED things (an album, a person, a place). Absent for
   *  a rail of bare photographs, where the photograph is the whole label. */
  label?: string;
  /** The cover's thumb URL, or `undefined` while a shelf has no cover to show
   *  — the tile then stands on `--skel`, the ground every unloaded tile in
   *  this app stands on, rather than a decorative tint. */
  uri?: string;
  /** The original, for the derivative-then-original retry ladder
   *  (kit/media/use-image-fallback.ts). */
  originalUri?: string;
  /** A person tile is a circle; every other tile is a rounded square. */
  round?: boolean;
}

export interface CollectionSection {
  key: CollectionSectionKey;
  title: string;
  /** The shelf's size, stated exactly. `undefined` for a section whose size
   *  is not a count a member would recognise. */
  count?: number;
  /** An inline verb on the heading row (iOS puts Create / Edit / Start
   *  Sharing there). At most one, and only where the section can actually
   *  perform it from here. */
  action?: string;
  tiles: CollectionTile[];
  /** What this section says when it holds nothing: what would appear here,
   *  and why it has not yet. Never "nothing here" — that names no cause and
   *  offers no road. */
  empty: string;
}

/** How many covers a rail carries before it stops. The rail scrolls, so this
 *  is not a cap on the shelf — it is a cap on how much of the shelf is worth
 *  building a tile for before a member has asked to see it. */
export const RAIL_LIMIT = 12;

export interface AlbumRow {
  collectionId: string;
  name: string;
  /** Members, resolved by the caller from `core.collection_entry`. */
  assetIds: readonly string[];
  /**
   * `core.collection.cover_content_id` — the member's own choice of key photo
   * (issue #721 B5, `set-album-cover`), resolved by the caller straight off
   * the collection row. `undefined` when nobody has chosen one, which is NOT
   * the same as "use the newest" being wrong — it is the fact that no choice
   * has been made yet, and `chosenCover` below reads it exactly that way.
   */
  coverContentId?: string;
}

export interface PlaceRow {
  placeId: string;
  /** Rounded shelf key shared by the place tile and its detail. */
  key: string;
  name: string;
}

export interface PersonRow {
  partyId: string;
  name: string;
  assetIds: readonly string[];
}

export interface CollectionFacts {
  /** The live timeline, exactly as the grid has it. */
  assets: readonly PhotoAsset[];
  albums: readonly AlbumRow[];
  places: readonly PlaceRow[];
  people: readonly PersonRow[];
  /** Every photograph taken on today's date in an earlier year
   *  (`timeline-model#onThisDay`), ungrouped — this file groups them by the
   *  year they belong to, which is what a member is actually being offered. */
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

/** The newest live photograph in a set — a shelf's cover is its most recent
 *  member, the same rule the timeline sorts by. */
function cover(assets: readonly PhotoAsset[]): PhotoAsset | undefined {
  let newest: PhotoAsset | undefined;
  for (const asset of assets) {
    // An undated asset has no instant to compare, so it can never win the
    // "newest" contest — but it can still be the cover of a shelf that holds
    // nothing else, which is better than a shelf with no cover at all.
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
 * An album's cover tile (issue #721 B5): the member's OWN choice when they
 * have made one, the newest member otherwise — never the reverse. This is
 * the fix for the defect this section used to carry: every rail tile called
 * `cover()` unconditionally and so a member's "Make cover"/"Make key photo"
 * write was honored by `AlbumDetail`'s own header but silently ignored by
 * every OTHER surface that draws this album, including this one. A chosen
 * cover that is no longer a live member of the album (removed, trashed) is
 * read exactly as "no choice" — `members` here is already the LIVE set
 * (`assetsOf`, in the caller below), so a stale id simply fails to match and
 * falls through to `cover()` honestly, rather than pinning a tile to a
 * photograph the rail cannot show.
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

/** Duplicate CLUSTERS: assets grouped by perceptual hash, keeping the groups
 *  with more than one member. The same grouping the More sheet's meta reports,
 *  so the two cannot disagree about how many there are. */
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

/** Today's memories, grouped by the year each belongs to, newest year first. */
function memoriesByYear(
  memories: readonly PhotoAsset[]
): Array<[string, PhotoAsset[]]> {
  const byYear = new Map<string, PhotoAsset[]>();
  for (const asset of memories) {
    // `onThisDay` already drops undated assets — nothing with no capture time
    // can be a memory of today — so this guard is belt and braces rather than
    // a live branch, and it keeps the year off `undefined.slice`.
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
 *
 * Order is an argument: Memories first because it is the only section that
 * changes on its own and is therefore the only one worth looking at without
 * being asked for; then the member's own filing (Albums, People, Places);
 * then the standing shelves — filters over the same library rather than
 * things the member named (Favorites, Videos); then the two that are
 * housekeeping rather than browsing (Duplicates, Trash), last because a
 * library is for looking at, not for tidying.
 */
export function buildCollectionSections(
  facts: CollectionFacts
): CollectionSection[] {
  const live = facts.assets.filter((asset) => !asset.deleted);
  // Indexed by BOTH ids a photograph answers to: `id` is the timeline row's
  // own key, `assetId` is the vault's `media_asset.asset_id` — which is
  // what an album entry and a face region point at. Indexing by one alone
  // silently resolves half the references to nothing.
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
  // Newest-first already, inherited from `live`'s own order
  // (`mergePhotoAssets`' sort) — the same free ride Favorites takes below.
  const videos = live.filter((asset) => asset.kind === "video");
  const trashed = facts.assets.filter((asset) => asset.deleted);
  const clusters = duplicateClusters(facts.assets);

  return [
    {
      key: "memories",
      title: "Memories",
      // One tile per YEAR, newest first — "this day, four years ago" is the
      // offer, so four photographs from the same afternoon are one memory and
      // not four.
      tiles: memoriesByYear(facts.memories)
        .slice(0, RAIL_LIMIT)
        .flatMap(([year, group]) => tileFor(cover(group), year)),
      empty:
        "A memory appears here when a day in your library has an earlier year behind it. Nothing is generated — it is your own photographs, on this day.",
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
      empty:
        "An album refers to a photograph where it lives; it never moves or copies anything. Select photographs and add them to one.",
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
        "A place appears here when a photograph carries where it was taken. Nothing is looked up over the network to put it there.",
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
      // Issue #721 B3. `PhotoAsset.kind === "video"` is the one media-type
      // fact this device already carries honestly — see the file header for
      // why Screenshots and Panoramas are not here beside it.
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
        "Photographs that look like each other are grouped here for you to decide about. Nothing is ever deleted for you.",
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
