// Grouped search hits (Photos v4 handoff §9, proto:4258-4265).
//
// Above the photographs, §9 draws the THINGS the query hit, each with a door
// into the surface that owns it.
//
// KEEP THIS MODULE PURE: no react-native, no replica imports, so every count is
// asserted directly (`search-hits.test.ts`) and none can be a placeholder. A
// group with no data path is OMITTED, never faked — hence no THINGS row
// (proto:4265): the vault has no scene/label entity yet.
//
// SEMANTIC (#721) is DERIVED DATA, never a gate: absent, `"unavailable"` and a
// failed fetch all read as "the group is not here".
//
// ORDERING AND CAPPING route through the blueprints' `groupSearchHits` (#712);
// MATCHING stays here, because token search over replica rows is a different
// algorithm from the web apps' substring match.
import { groupSearchHits } from "@centraid/blueprints/apps/_shared/search-scaffold";
import type { SearchEntity } from "@centraid/blueprints/apps/_shared/search-scaffold";

import {
  NO_LOCATION_KEY,
  NO_LOCATION_NAME,
  assetsWithNoPlace,
} from "./places-model";
// Which words stand for a place, and what it is called once found, live in
// their own leaf (#816); `rowText` comes back out of it as the shared reader.
import {
  homeAnchor,
  namedPlaceAnchors,
  noLocationAsked,
  placeLabel,
  placeVocabulary,
  rowText,
} from "./search-place-vocabulary";
import type { PhotoAsset } from "./timeline-model";

/** A replica row, as the query hooks hand it over. */
type Row = Record<string, unknown>;

/** Declared in the order they are drawn — see `SEARCH_HIT_ENTITIES`. */
export type SearchHitKind =
  | "person"
  | "place"
  | "album"
  | "caption"
  | "semantic";

/** Data, never a closure at the call site: a target is a REAL surface that owns
 *  the thing named in the row, and a test checks the pairing. */
export type SearchHitTarget =
  | {
      screen: "PhotoStateView";
      params: { mode: "person"; partyId: string; personName: string };
    }
  | { screen: "PlacesMap" }
  | {
      screen: "PlaceDetail";
      params: { placeKey: string; placeName: string };
    }
  | { screen: "AlbumDetail"; params: { albumId: string } }
  | { screen: "PhotoLightbox"; params: { assetId: string } };

export interface SearchHit {
  /** Stable across renders and unique across kinds. */
  key: string;
  kind: SearchHitKind;
  /** The thing's own name — a caption is quoted, because it is speech. */
  label: string;
  /** `person · 412 photographs` — what it is, then how big it is. */
  sub: string;
  /** `12 here` — the overlap with THESE results. Empty where that number means
   *  nothing (an album row states its size, not its overlap). */
  meta: string;
  /** The `media_asset` ids this hit REACHES (#712). Carried out on the row
   *  because the joins are already walked here; the screen unions them into the
   *  grid, so naming an album shows its photographs even though none of them
   *  carries the word in its own title. */
  assetIds: readonly string[];
  target: SearchHitTarget;
}

export interface SearchHitSources {
  query: string;
  /** The photographs drawn below the rows. */
  matches: readonly PhotoAsset[];
  /** The whole library the phone can see, for the "how big is it" halves. */
  assets: readonly PhotoAsset[];
  parties: readonly Row[];
  /** `media.face_region` — which party is in which asset. */
  faces: readonly Row[];
  places: readonly Row[];
  collections: readonly Row[];
  entries: readonly Row[];
  /** `core.content_id` → title. The column `REPLICA_LOCAL_SEARCH` indexes, so
   *  it is exactly what a caption hit hit. */
  contentTitles: ReadonlyMap<string, string>;
  /** Present only on a `status: "ok"` answer (#721); `undefined` covers every
   *  other reason there is nothing to show. */
  semanticHits?: readonly {
    assetId: string;
    contentId: string;
    score: number;
  }[];
}

/** Without this, "the coast road" pulls in every album containing "the", and a
 *  list of false hits above the true ones is worse than no list. */
const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "from",
  "in",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

/** The list is a summary of what was hit, not a second result set. */
const PER_KIND_CAP = 3;

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `30 July 2026`. Never `toLocaleDateString`, whose output moves with the
 *  device locale; every date this app prints must read the same. */
export function captionDate(iso: string): string {
  const day = Number(iso.slice(8, 10));
  const month = MONTHS[Number(iso.slice(5, 7)) - 1];
  const year = iso.slice(0, 4);
  if (!month || Number.isNaN(day)) return iso.slice(0, 10);
  return `${day} ${month} ${year}`;
}

export function queryTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function matchesTokens(name: string, tokens: readonly string[]): boolean {
  const lowered = name.toLowerCase();
  return tokens.some((token) => lowered.includes(token));
}

function plural(count: number): string {
  return `${count} photograph${count === 1 ? "" : "s"}`;
}

/** `matchedAssetIds` is computed once here rather than per entity. */
interface HitSource extends SearchHitSources {
  matchedAssetIds: ReadonlySet<string>;
}

const PERSON_ENTITY: SearchEntity<HitSource, SearchHit> = {
  key: "person",
  label: "person",
  match: (term, source) =>
    personHits(source, queryTokens(term), source.matchedAssetIds),
};
const PLACE_ENTITY: SearchEntity<HitSource, SearchHit> = {
  key: "place",
  label: "place",
  match: (term, source) => placeHits(source, queryTokens(term)),
};
const ALBUM_ENTITY: SearchEntity<HitSource, SearchHit> = {
  key: "album",
  label: "album",
  match: (term, source) => albumHits(source, queryTokens(term)),
};
const CAPTION_ENTITY: SearchEntity<HitSource, SearchHit> = {
  key: "caption",
  label: "caption",
  match: (term, source) => captionHits(source, queryTokens(term)),
};
const SEMANTIC_ENTITY: SearchEntity<HitSource, SearchHit> = {
  key: "semantic",
  label: "semantic",
  // Ignores `term`: the embedding model already decided. Re-matching by
  // substring here would be the token search this row exists to go beyond.
  match: (_term, source) => semanticEntityHits(source),
};

/** Narrowest to broadest, which is also proto:4258-4265's order; semantic is a
 *  ranked slice of the whole library, so it goes last. Data, never a branch. */
const SEARCH_HIT_ENTITIES: readonly SearchEntity<HitSource, SearchHit>[] = [
  PERSON_ENTITY,
  PLACE_ENTITY,
  ALBUM_ENTITY,
  CAPTION_ENTITY,
  SEMANTIC_ENTITY,
];

/** The rows above the grid, in `SEARCH_HIT_ENTITIES` order. */
export function groupedSearchHits(sources: SearchHitSources): SearchHit[] {
  const matchedAssetIds = new Set(
    sources.matches.flatMap((asset) => (asset.assetId ? [asset.assetId] : []))
  );
  return groupSearchHits(
    sources.query,
    { ...sources, matchedAssetIds },
    SEARCH_HIT_ENTITIES,
    PER_KIND_CAP
  );
}

/** Unioned by the grid with the title matches, so naming an album shows the
 *  photographs that belong to it (#712). */
export function reachableAssetIds(hits: readonly SearchHit[]): Set<string> {
  return new Set(hits.flatMap((hit) => [...hit.assetIds]));
}

function personHits(
  sources: SearchHitSources,
  tokens: readonly string[],
  matchedAssetIds: ReadonlySet<string>
): SearchHit[] {
  // Confirmed party first, proposed otherwise — `PhotosPeopleView` counts by the
  // same rule, so a person's number cannot differ between the two surfaces.
  const total = new Map<string, Set<string>>();
  const here = new Map<string, number>();
  for (const face of sources.faces) {
    const partyId = face.confirmed_by_party_id ?? face.party_id;
    const assetId = face.asset_id;
    if (!partyId || !assetId) continue;
    const key = String(partyId);
    const asset = String(assetId);
    const seen = total.get(key) ?? new Set<string>();
    if (!seen.has(asset)) {
      seen.add(asset);
      total.set(key, seen);
      if (matchedAssetIds.has(asset)) here.set(key, (here.get(key) ?? 0) + 1);
    }
  }

  return sources.parties
    .flatMap((party) => {
      const id = rowText(party, "party_id");
      if (!id) return [];
      const name = rowText(party, "display_name", "name");
      if (!name || !matchesTokens(name, tokens)) return [];
      const seen = total.get(id);
      const count = seen?.size ?? 0;
      if (count === 0) return [];
      return [
        {
          key: `person:${id}`,
          kind: "person" as const,
          label: name,
          sub: `person · ${plural(count)}`,
          meta: `${here.get(id) ?? 0} here`,
          assetIds: [...(seen ?? [])],
          target: {
            screen: "PhotoStateView" as const,
            params: { mode: "person" as const, partyId: id, personName: name },
          },
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function placeHits(
  sources: SearchHitSources,
  tokens: readonly string[]
): SearchHit[] {
  const total = new Map<string, number>();
  // Not the same number as the count: an asset with no `assetId` counts toward
  // the place but cannot be shown in the grid.
  const reachable = new Map<string, string[]>();
  for (const asset of sources.assets) {
    if (!asset.placeId) continue;
    total.set(asset.placeId, (total.get(asset.placeId) ?? 0) + 1);
    if (!asset.assetId) continue;
    const ids = reachable.get(asset.placeId) ?? [];
    ids.push(asset.assetId);
    reachable.set(asset.placeId, ids);
  }
  const here = new Map<string, number>();
  for (const asset of sources.matches) {
    if (!asset.placeId) continue;
    here.set(asset.placeId, (here.get(asset.placeId) ?? 0) + 1);
  }

  // Both the matchable words and the printed title are
  // `search-place-vocabulary.ts`'s answers (#816) — they are not the same set.
  const anchors = namedPlaceAnchors(sources.places);
  const home = homeAnchor(anchors);

  const named = sources.places
    .flatMap((place) => {
      const id = rowText(place, "place_id");
      if (!id) return [];
      const words = placeVocabulary(place, home);
      if (!words.some((word) => matchesTokens(word, tokens))) return [];
      const count = total.get(id) ?? 0;
      if (count === 0) return [];
      return [
        {
          key: `place:${id}`,
          kind: "place" as const,
          label: placeLabel(place, anchors),
          sub: `place · ${plural(count)}`,
          meta: `${here.get(id) ?? 0} here`,
          assetIds: reachable.get(id) ?? [],
          // The phone has no per-place shelf; Places IS the map.
          target: { screen: "PlacesMap" as const },
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // The bucket goes LAST: it is the widest place answer, and a member who typed
  // a name wants the name first.
  return [...named, ...noLocationHits(sources, tokens)];
}

/** The no-location bucket as a search answer (#816). Which words ask for it is
 *  `noLocationAsked`'s call — matched as a phrase, not by token. */
function noLocationHits(
  sources: SearchHitSources,
  tokens: readonly string[]
): SearchHit[] {
  if (tokens.length === 0 || !noLocationAsked(sources.query)) return [];
  const placeless = assetsWithNoPlace(sources.assets);
  if (placeless.length === 0) return [];
  const here = assetsWithNoPlace(sources.matches).length;
  return [
    {
      key: `place:${NO_LOCATION_KEY}`,
      kind: "place",
      label: NO_LOCATION_NAME,
      sub: `place · ${plural(placeless.length)}`,
      meta: `${here} here`,
      assetIds: placeless.flatMap((asset) =>
        asset.assetId ? [asset.assetId] : []
      ),
      // The same reserved key `PlacesView`'s trailing card opens.
      target: {
        screen: "PlaceDetail",
        params: { placeKey: NO_LOCATION_KEY, placeName: NO_LOCATION_NAME },
      },
    },
  ];
}

function albumHits(
  sources: SearchHitSources,
  tokens: readonly string[]
): SearchHit[] {
  const sizes = new Map<string, number>();
  // An entry with no `target_id` still counts toward the album's stated size,
  // but there is nothing for the grid to show for it.
  const members = new Map<string, string[]>();
  for (const entry of sources.entries) {
    const id = rowText(entry, "collection_id");
    if (!id) continue;
    sizes.set(id, (sizes.get(id) ?? 0) + 1);
    const target = rowText(entry, "target_id");
    if (!target) continue;
    const ids = members.get(id) ?? [];
    ids.push(target);
    members.set(id, ids);
  }

  return sources.collections
    .flatMap((collection) => {
      const id = rowText(collection, "collection_id");
      if (!id) return [];
      const name = rowText(collection, "name", "title");
      if (!name || !matchesTokens(name, tokens)) return [];
      return [
        {
          key: `album:${id}`,
          kind: "album" as const,
          label: name,
          sub: `album · ${plural(sizes.get(id) ?? 0)}`,
          // An album row states its size and nothing else (proto:4262).
          meta: "",
          assetIds: members.get(id) ?? [],
          target: {
            screen: "AlbumDetail" as const,
            params: { albumId: id },
          },
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function captionHits(
  sources: SearchHitSources,
  tokens: readonly string[]
): SearchHit[] {
  // No early break at `PER_KIND_CAP`: `groupSearchHits` caps every entity
  // uniformly, and a second cap point could drift from the other four.
  const hits: SearchHit[] = [];
  for (const asset of sources.matches) {
    const title = asset.contentId
      ? sources.contentTitles.get(asset.contentId)
      : undefined;
    if (!title || !matchesTokens(title, tokens)) continue;
    hits.push({
      key: `caption:${asset.id}`,
      kind: "caption",
      label: `“${title}”`,
      // An undated caption is still worth finding; the date is left off
      // rather than printed as a guess.
      sub: asset.capturedAt
        ? `caption · ${captionDate(asset.capturedAt)}`
        : "caption",
      meta: "",
      assetIds: asset.assetId ? [asset.assetId] : [],
      target: {
        screen: "PhotoLightbox",
        params: { assetId: asset.id },
      },
    });
  }
  return hits;
}

/**
 * ONE row for the gateway's whole ranked set (#721), never one per scored hit —
 * a ranked list of photographs is one thing, scored.
 *
 * Hits are resolved against `sources.assets`: an id the timeline has not loaded
 * is DROPPED, or it reaches the grid as a dangling id with no tile. `target`
 * opens the strongest match, while `assetIds` carries the whole resolved set
 * into the grid whether or not the row is ever tapped.
 */
function semanticEntityHits(sources: SearchHitSources): SearchHit[] {
  const hits = sources.semanticHits;
  if (!hits?.length) return [];
  const byAssetId = new Map(
    sources.assets.flatMap((asset) =>
      asset.assetId ? [[asset.assetId, asset] as const] : []
    )
  );
  const ranked = [...hits]
    .sort((a, b) => b.score - a.score)
    .flatMap((hit) => {
      const asset = byAssetId.get(hit.assetId);
      return asset ? [asset] : [];
    });
  const top = ranked[0];
  if (!top) return [];
  return [
    {
      key: "semantic",
      kind: "semantic",
      label: `Photos that look like “${sources.query.trim()}”`,
      sub: `semantic · ${plural(ranked.length)}`,
      // No "N here": the network already scoped its answer to this query.
      meta: "",
      assetIds: ranked.flatMap((asset) =>
        asset.assetId ? [asset.assetId] : []
      ),
      target: {
        screen: "PhotoLightbox",
        params: { assetId: top.id },
      },
    },
  ];
}
