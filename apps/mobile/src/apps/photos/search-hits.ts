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
//   — the media domain is `media.asset`, `media.face_region` and
//   `media.asset_phash`, and nothing else. There is nothing to count, so there
//   is no row. Add it here the moment an enrichment publisher lands labels.
//
// SEMANTIC (issue #721 B4) is not that publisher, and not a THINGS row either
// — it does not name discrete labels a photograph carries, it ranks the whole
// library against the query by a gateway embedding model
// (`POST …/enrich/semantic-search`) and hands back scored photograph ids. One
// row stands for that whole ranked set ("Photos that look like …"), broadest
// of the five because it is not about any one person/place/album/caption —
// see `SEARCH_HIT_ENTITIES` for where it sits. It is DERIVED DATA, never a
// gate: absent, `"unavailable"`, or a failed fetch all read as "the group
// simply is not here" (`semanticEntityHits`, below) — the other four rows and
// the grid beneath them are exactly as capable either way.
//
// ORDERING AND CAPPING (issue #712 S1) route through the web blueprints'
// shared `groupSearchHits` combinator — the same "find, then cap, then
// order" the web scaffold's Photos and Tally consumers use
// (`packages/blueprints/apps/_shared/search-scaffold.ts`) — instead of a
// fourth hand-inlined `[...a(), ...b(), ...c(), ...d()]`. The MATCHING stays
// entirely in this file (token search over replica rows is a genuinely
// different algorithm from the two web apps' plain substring match, per that
// module's own header note); only the "run each kind, cap it, concatenate in
// order" shell is shared. This is a pure-logic import with no UI change —
// this file already had zero react-native imports, and stays that way.
import { groupSearchHits } from "@centraid/blueprints/apps/_shared/search-scaffold";
import type { SearchEntity } from "@centraid/blueprints/apps/_shared/search-scaffold";

import type { PhotoAsset } from "./timeline-model";

/** A replica row, as the query hooks hand it over. */
type Row = Record<string, unknown>;

/**
 * The groups the phone can actually answer. The first four are proto:4258-
 * 4265's order; `semantic` (issue #721 B4) is a fifth, added after them —
 * see `SEARCH_HIT_ENTITIES` for why it is broadest and therefore last.
 */
export type SearchHitKind =
  | "person"
  | "place"
  | "album"
  | "caption"
  | "semantic";

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
  /**
   * The `media_asset` ids this hit REACHES (#712): the album's members, the
   * person's faces, the place's photographs, the caption's own photograph.
   *
   * A member who types "Tahoe" and is shown the album "Tahoe scouting" means
   * its four photographs, but none of THEM carries the word in its own
   * `core.content_item.title`, so `session.search` cannot return them and the
   * grid came back empty under a row that said the album exists. The joins
   * that answer "which photographs is this row about" are already walked here
   * — faces by party, entries by collection, assets by place — so the answer
   * is carried out on the row rather than re-derived by the screen from the
   * same rows a second time.
   */
  assetIds: readonly string[];
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
  /**
   * The gateway's embedding match for this query (issue #721 B4), present
   * only once `POST …/enrich/semantic-search` has answered `status: "ok"`.
   * `undefined` covers every other reason there is nothing to show — no
   * gateway, the model reporting `"unavailable"`, or the request simply
   * failing — and every one of those reads exactly the same here: the group
   * is absent, not broken (see the file header).
   */
  semanticHits?: readonly {
    assetId: string;
    contentId: string;
    score: number;
  }[];
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

/** `SearchHitSources` plus the one value the person entity needs that is
 *  cheaper to compute once than per-entity: which assets are already among
 *  the loaded hits. */
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
  // Ignores `term` entirely — the gateway's embedding model already decided
  // which photographs match `source.query`, so re-matching by substring here
  // would be exactly the token search this row exists to go beyond.
  match: (_term, source) => semanticEntityHits(source),
};

/** Person → place → album → caption → semantic. The first four are
 *  proto:4258-4265's order and also narrowest-to-broadest: a person is one
 *  identity, a caption is one photograph's words. Semantic is broadest of
 *  all — a ranked slice of the whole library, not one named thing — so it is
 *  appended last. Declared as data (`SEARCH_HIT_ENTITIES`), not a branch, the
 *  same rule the web scaffold's own entity configs follow. */
const SEARCH_HIT_ENTITIES: readonly SearchEntity<HitSource, SearchHit>[] = [
  PERSON_ENTITY,
  PLACE_ENTITY,
  ALBUM_ENTITY,
  CAPTION_ENTITY,
  SEMANTIC_ENTITY,
];

/**
 * The rows above the grid. Ordered person → place → album → caption, which is
 * proto:4258-4265's order and is also narrowest-to-broadest: a person is one
 * identity, a caption is one photograph's words.
 */
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

/**
 * Every asset id reachable through these rows, deduplicated (#712). The
 * search grid unions this with the photographs `session.search` matched by
 * title, so naming an album, a person or a place shows the photographs that
 * belong to it — which is what naming one of them asks for.
 */
export function reachableAssetIds(hits: readonly SearchHit[]): Set<string> {
  return new Set(hits.flatMap((hit) => [...hit.assetIds]));
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
  // The ids are collected in the same pass as the count, but they are not the
  // same number: a photograph the replica holds without an `assetId` is still
  // one of the place's photographs to count, and still not something the grid
  // can be asked to show.
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
          assetIds: reachable.get(id) ?? [],
          // The phone has no per-place shelf; Places IS the map (`PlacesMap`,
          // the More-sheet row). Sending the member to the map is the honest
          // reading of "open the place" here — not a filtered grid that does
          // not exist.
          target: { screen: "PlacesMap" as const },
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

function albumHits(
  sources: SearchHitSources,
  tokens: readonly string[]
): SearchHit[] {
  const sizes = new Map<string, number>();
  // `target_id` is the member asset. An entry without one still counts toward
  // the album's stated size — it is a row in the album — but there is nothing
  // for the grid to show for it.
  const members = new Map<string, string[]>();
  for (const entry of sources.entries) {
    const id = text(entry, "collection_id");
    if (!id) continue;
    sizes.set(id, (sizes.get(id) ?? 0) + 1);
    const target = text(entry, "target_id");
    if (!target) continue;
    const ids = members.get(id) ?? [];
    ids.push(target);
    members.set(id, ids);
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
  // No early break at `PER_KIND_CAP` here — `groupedSearchHits` caps every
  // entity uniformly via the shared `groupSearchHits` combinator, after this
  // returns every real match in order. Capping first and matching second
  // would be the same result for this loop's own single pass, but a second
  // cap point is one more place the number could drift from the other three
  // entities'.
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
      // A caption on an undated photograph is still a caption worth finding;
      // the date is simply left off rather than printed as a guess.
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
 * The ONE semantic row (issue #721 B4) — "Photos that look like …", standing
 * for the gateway's whole ranked set rather than one row per scored hit
 * (unlike person/place/album, which are genuinely many named things; a
 * ranked list of photographs is one thing, scored).
 *
 * `sources.assets` is what resolves a bare `assetId` the network returned
 * into a real timeline row: a hit the timeline has not (yet) loaded is
 * dropped rather than reaching the grid as a dangling id `reachableAssetIds`
 * cannot turn into a tile. `target` opens the single strongest match — the
 * same "one real destination" rule every other row here follows — while
 * `assetIds` still carries the WHOLE resolved set into the grid below,
 * regardless of whether the row itself is ever tapped.
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
      // No "N here" — unlike person/place, the network already scoped its
      // answer to this exact query; a second count would restate the same
      // number under a different name.
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
