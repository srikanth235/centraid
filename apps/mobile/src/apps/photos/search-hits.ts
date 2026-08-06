// Grouped search hits (Photos v4 handoff §9, proto:4258-4265).
//
// §9's search surface is not "a filtered grid". Above the photographs it draws
// a short list of the THINGS the query hit — a person, a place, an album, a
// caption — each with what it is, how big it is, how much of it is in these
// results, and a way into the surface that actually owns it:
//
//   Ana                 person · 412 photographs      12 here    Open →
//   Lyme Regis          place · 96 photographs         8 here    Open →
//   The coast road      album · 184 photographs                  Open →
//   “Ana on the sea…”   caption · 30 July 2026                   Open →
//
// That is the whole substance of the shelf: a member who types a name gets the
// PERSON, not a scattering of tiles that happen to have her in them.
//
// This module is deliberately pure and free of react-native / replica imports.
// Every count it emits is derived from rows the phone already reads, so the
// rows can be asserted directly (`search-hits.test.ts`) rather than eyeballed
// on a simulator — and, more importantly, so no count in this file can ever be
// a placeholder. A group with no data path on the phone is OMITTED, never
// faked:
//
//   THINGS is omitted. proto:4265 lists a `things` row (`beach, sea, coat ·
//   found in 74 photographs`), but the vault has no scene/label entity at all
//   — the media domain is `media.media_asset`, `media.face_region` and
//   `media.asset_phash`, and nothing else. There is nothing to count, so there
//   is no row. Add it here the moment an enrichment publisher lands labels.

import type { PhotoAsset } from "./timeline-model";

/** A replica row, as the query hooks hand it over. */
type Row = Record<string, unknown>;

/** The four groups the phone can actually answer, in proto:4258-4265's order. */
export type SearchHitKind = "person" | "place" | "album" | "caption";

/**
 * Where a hit's `Open →` goes. Every one of these is a REAL surface that owns
 * the thing named in the row — the defect this issue is about is a labelled
 * control that opens something else, so the target is data, checked by a test,
 * rather than a closure written at the call site.
 */
export type SearchHitTarget =
  | {
      screen: "PhotoStateView";
      params: { mode: "person"; partyId: string; personName: string };
    }
  | { screen: "PlacesMap" }
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
  /** `12 here` — how much of it is in THESE results. Empty where the number
   *  would not mean anything (an album row states its size, not its overlap). */
  meta: string;
  target: SearchHitTarget;
}

export interface SearchHitSources {
  /** What the member typed. */
  query: string;
  /** The assets this query matched — the photographs drawn below the rows. */
  matches: readonly PhotoAsset[];
  /** The whole library the phone can see, for the "how big is it" halves. */
  assets: readonly PhotoAsset[];
  /** `core.party` — a person's identity. */
  parties: readonly Row[];
  /** `media.face_region` — which party is in which asset. */
  faces: readonly Row[];
  /** `core.place`. */
  places: readonly Row[];
  /** `core.collection` — albums. */
  collections: readonly Row[];
  /** `core.collection_entry` — album membership. */
  entries: readonly Row[];
  /** `core.content_id` → title, from `core.content_item`. This is the column
   *  the replica's own FTS surface indexes (`REPLICA_LOCAL_SEARCH`), so it is
   *  exactly what a caption hit hit. */
  contentTitles: ReadonlyMap<string, string>;
}

/**
 * Words that are in every third name in a library and therefore match nothing
 * useful. Without this, "the coast road" pulls in every album whose name
 * contains "the" — a list of false hits above the true ones is worse than no
 * list, because the member cannot tell which is which.
 */
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

/** At most this many rows per group. The list is a summary of what was hit,
 *  not a second result set — past three, the photographs are the better view. */
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

/** `30 July 2026`. Written out rather than left to `toLocaleDateString`, whose
 *  output changes with the device locale — the caption row's date must read
 *  the same as every other date this app prints. */
export function captionDate(iso: string): string {
  const day = Number(iso.slice(8, 10));
  const month = MONTHS[Number(iso.slice(5, 7)) - 1];
  const year = iso.slice(0, 4);
  if (!month || Number.isNaN(day)) return iso.slice(0, 10);
  return `${day} ${month} ${year}`;
}

/** The words worth matching on. */
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

function text(row: Row, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim()) return String(value);
  }
  return undefined;
}

/**
 * The rows above the grid. Ordered person → place → album → caption, which is
 * proto:4258-4265's order and is also narrowest-to-broadest: a person is one
 * identity, a caption is one photograph's words.
 */
export function groupedSearchHits(sources: SearchHitSources): SearchHit[] {
  const tokens = queryTokens(sources.query);
  if (tokens.length === 0) return [];

  const matchedAssetIds = new Set(
    sources.matches.flatMap((asset) => (asset.assetId ? [asset.assetId] : []))
  );

  return [
    ...personHits(sources, tokens, matchedAssetIds),
    ...placeHits(sources, tokens),
    ...albumHits(sources, tokens),
    ...captionHits(sources, tokens),
  ];
}

function personHits(
  sources: SearchHitSources,
  tokens: readonly string[],
  matchedAssetIds: ReadonlySet<string>
): SearchHit[] {
  // A face counts for the party it was CONFIRMED onto where there is one, and
  // for its proposed party otherwise — the same rule `PhotosPeopleView` counts
  // by, so a person's number does not change between the two surfaces.
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
      const id = text(party, "party_id");
      if (!id) return [];
      const name = text(party, "display_name", "name");
      if (!name || !matchesTokens(name, tokens)) return [];
      const count = total.get(id)?.size ?? 0;
      if (count === 0) return [];
      return [
        {
          key: `person:${id}`,
          kind: "person" as const,
          label: name,
          sub: `person · ${plural(count)}`,
          meta: `${here.get(id) ?? 0} here`,
          target: {
            screen: "PhotoStateView" as const,
            params: { mode: "person" as const, partyId: id, personName: name },
          },
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, PER_KIND_CAP);
}

function placeHits(
  sources: SearchHitSources,
  tokens: readonly string[]
): SearchHit[] {
  const total = new Map<string, number>();
  for (const asset of sources.assets) {
    if (!asset.placeId) continue;
    total.set(asset.placeId, (total.get(asset.placeId) ?? 0) + 1);
  }
  const here = new Map<string, number>();
  for (const asset of sources.matches) {
    if (!asset.placeId) continue;
    here.set(asset.placeId, (here.get(asset.placeId) ?? 0) + 1);
  }

  return sources.places
    .flatMap((place) => {
      const id = text(place, "place_id");
      if (!id) return [];
      const name = text(place, "name", "label");
      if (!name || !matchesTokens(name, tokens)) return [];
      const count = total.get(id) ?? 0;
      if (count === 0) return [];
      return [
        {
          key: `place:${id}`,
          kind: "place" as const,
          label: name,
          sub: `place · ${plural(count)}`,
          meta: `${here.get(id) ?? 0} here`,
          // The phone has no per-place shelf; Places IS the map (`PlacesMap`,
          // the More-sheet row). Sending the member to the map is the honest
          // reading of "open the place" here — not a filtered grid that does
          // not exist.
          target: { screen: "PlacesMap" as const },
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, PER_KIND_CAP);
}

function albumHits(
  sources: SearchHitSources,
  tokens: readonly string[]
): SearchHit[] {
  const sizes = new Map<string, number>();
  for (const entry of sources.entries) {
    const id = text(entry, "collection_id");
    if (!id) continue;
    sizes.set(id, (sizes.get(id) ?? 0) + 1);
  }

  return sources.collections
    .flatMap((collection) => {
      const id = text(collection, "collection_id");
      if (!id) return [];
      const name = text(collection, "name", "title");
      if (!name || !matchesTokens(name, tokens)) return [];
      return [
        {
          key: `album:${id}`,
          kind: "album" as const,
          label: name,
          sub: `album · ${plural(sizes.get(id) ?? 0)}`,
          // An album row states its size and nothing else (proto:4262). "How
          // many of it are here" is not a fact about an album the member asked
          // for by name.
          meta: "",
          target: {
            screen: "AlbumDetail" as const,
            params: { albumId: id },
          },
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label))
    .slice(0, PER_KIND_CAP);
}

function captionHits(
  sources: SearchHitSources,
  tokens: readonly string[]
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const asset of sources.matches) {
    if (hits.length >= PER_KIND_CAP) break;
    const title = asset.contentId
      ? sources.contentTitles.get(asset.contentId)
      : undefined;
    if (!title || !matchesTokens(title, tokens)) continue;
    hits.push({
      key: `caption:${asset.id}`,
      kind: "caption",
      label: `“${title}”`,
      sub: `caption · ${captionDate(asset.capturedAt)}`,
      meta: "",
      target: {
        screen: "PhotoLightbox",
        params: { assetId: asset.id },
      },
    });
  }
  return hits;
}
