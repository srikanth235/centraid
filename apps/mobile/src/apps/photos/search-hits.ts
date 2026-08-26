// Grouped search hits (Photos §9). KEEP PURE. Omit a group with no data path; never fake.
// Semantic (#721) is derived, never a gate. Order/cap via `groupSearchHits` (#712); matching stays here.
import { groupSearchHits } from "@centraid/blueprints/apps/_shared/search-scaffold";
import type { SearchEntity } from "@centraid/blueprints/apps/_shared/search-scaffold";

import {
  NO_LOCATION_KEY,
  NO_LOCATION_NAME,
  assetsWithNoPlace,
} from "./places-model";
import {
  homeAnchor,
  namedPlaceAnchors,
  noLocationAsked,
  placeLabel,
  placeVocabulary,
  rowText,
} from "./search-place-vocabulary";
import type { PhotoAsset } from "./timeline-model";

type Row = Record<string, unknown>;

export type SearchHitKind =
  | "person"
  | "place"
  | "album"
  | "caption"
  | "semantic";

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
  key: string;
  kind: SearchHitKind;
  /** Quoted for a caption (speech). */
  label: string;
  sub: string;
  /** Overlap with these results. Empty where that number means nothing (album states size). */
  meta: string;
  /** `media_asset` ids this hit reaches (#712) — the screen unions them into the grid. */
  assetIds: readonly string[];
  target: SearchHitTarget;
}

export interface SearchHitSources {
  query: string;
  matches: readonly PhotoAsset[];
  assets: readonly PhotoAsset[];
  parties: readonly Row[];
  faces: readonly Row[];
  places: readonly Row[];
  collections: readonly Row[];
  entries: readonly Row[];
  contentTitles: ReadonlyMap<string, string>;
  /** Present only on `status: "ok"` (#721); `undefined` covers every other empty. */
  semanticHits?: readonly {
    assetId: string;
    contentId: string;
    score: number;
  }[];
}

/** Without this, "the coast road" pulls every album containing "the". */
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

/** `30 July 2026`. Never `toLocaleDateString` — locale must not move printed dates. */
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
  // Ignore `term`: the embedding already decided. Substring re-match would be the token search this row exists to go beyond.
  match: (_term, source) => semanticEntityHits(source),
};

/** Narrowest to broadest; semantic last. Data, never a branch. */
const SEARCH_HIT_ENTITIES: readonly SearchEntity<HitSource, SearchHit>[] = [
  PERSON_ENTITY,
  PLACE_ENTITY,
  ALBUM_ENTITY,
  CAPTION_ENTITY,
  SEMANTIC_ENTITY,
];

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

/** Unioned with title matches so naming an album shows its photographs (#712). */
export function reachableAssetIds(hits: readonly SearchHit[]): Set<string> {
  return new Set(hits.flatMap((hit) => [...hit.assetIds]));
}

function personHits(
  sources: SearchHitSources,
  tokens: readonly string[],
  matchedAssetIds: ReadonlySet<string>
): SearchHit[] {
  // Confirmed party first, else proposed — same rule as `PhotosPeopleView`.
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
  // Asset with no `assetId` counts toward the place but cannot be shown in the grid.
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

  // Matchable words ≠ printed title (#816).
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
          target: { screen: "PlacesMap" as const },
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // No-location bucket last — a typed name wants the name first.
  return [...named, ...noLocationHits(sources, tokens)];
}

/** No-location bucket (#816). Phrase match via `noLocationAsked`, not tokens. */
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
  // Entry with no `target_id` still counts toward album size, but the grid has nothing to show.
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
  // No early break at `PER_KIND_CAP` — `groupSearchHits` caps every entity uniformly.
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

/** One row for the gateway's ranked set (#721). Drop ids the timeline has not loaded. `target` is the strongest match. */
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
