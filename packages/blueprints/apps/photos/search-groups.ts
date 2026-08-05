// Grouped hits above the Search shelf's photo grid (v4 handoff §9, ~4258-4265):
// a ruled row per person / place / album / "things" (tag) the query matches,
// each with `Open →` to the shelf that owns it, THEN the justified grid.
//
// PURE AND HONEST. This takes only data app-root.tsx already holds — the
// people roster, the place sections, the album list, the tags carried on the
// loaded assets — and matches it against the query text. It invents nothing:
// a group with no real backing data (see the caption note below) is left out
// of `SearchGroupKind` entirely rather than faked from the photo grid.
//
// CAPTIONS ARE DELIBERATELY OMITTED. The handoff's fifth example row is a
// caption hit, but a caption is `Asset.title` (LightboxInfo.tsx) — a
// per-photograph fact, not an aggregate with a name and a count the way a
// person, a place, an album or a tag is. The photographs a caption matched
// are already the photo grid this module sits above; a summary row here
// would either repeat the grid or invent an aggregate ("N captions matched")
// nobody asked the data for. Wiring it honestly would need a caption-level
// destination this app does not have, so it is left out rather than faked.
import type { PlaceSection } from "./components/Places.tsx";
import type { Person } from "./people.ts";
import { personShelf, PLACES } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type { Album, Asset } from "./types.ts";

/** The four groups this app can honestly back with real data. */
export type SearchGroupKind = "person" | "place" | "album" | "things";

export interface SearchGroupHit {
  kind: SearchGroupKind;
  /** Stable across a render — the party id, place key, album id or tag
   *  label, so React never confuses one hit for another. */
  key: string;
  title: string;
  /** The `<kind> · …` line under the title. */
  meta: string;
  /** The person-only "N here" — how many of their photographs are in the
   *  hits already on screen, not their whole library count. Omitted for
   *  every other kind: a place/album/tag's count IS the "found in N
   *  photographs" line, so a second number would answer the same question
   *  twice. */
  here?: string;
  /** Where `Open →` takes this hit. */
  targetShelf: ShelfId;
}

const MAX_PER_GROUP = 3;

function matches(term: string, value: string | null | undefined): boolean {
  if (!value) return false;
  return value.toLowerCase().includes(term);
}

function personGroup(
  term: string,
  people: readonly Person[],
  hits: readonly Asset[]
): SearchGroupHit[] {
  const hitIds = new Set(hits.map((a) => a.asset_id));
  return people
    .filter((person) => matches(term, person.name))
    .slice(0, MAX_PER_GROUP)
    .map((person) => ({
      kind: "person" as const,
      key: person.party_id,
      title: person.name ?? "Someone",
      meta: `person · ${person.count} ${person.count === 1 ? "photograph" : "photographs"}`,
      here: `${person.asset_ids.filter((id) => hitIds.has(id)).length} here`,
      targetShelf: personShelf(person.party_id),
    }));
}

function placeGroup(
  term: string,
  sections: readonly PlaceSection[]
): SearchGroupHit[] {
  return sections
    .filter((section) => matches(term, section.name))
    .slice(0, MAX_PER_GROUP)
    .map((section) => ({
      kind: "place" as const,
      key: section.key || "unnamed",
      // `section.name` is guaranteed truthy here — `matches` returns false
      // for null/"", which the filter above already dropped.
      title: section.name as string,
      meta: `place · ${section.assets.length} ${section.assets.length === 1 ? "photograph" : "photographs"}`,
      // Places has no per-place route yet (PLACES is one shelf of sections,
      // not N shelves) — Open lands on the shelf that shows this section.
      targetShelf: PLACES,
    }));
}

function albumGroup(term: string, albums: readonly Album[]): SearchGroupHit[] {
  return albums
    .filter((album) => matches(term, album.title))
    .slice(0, MAX_PER_GROUP)
    .map((album) => ({
      kind: "album" as const,
      key: album.album_id,
      title: album.title ?? "Album",
      meta: `album · ${album.count ?? 0} ${album.count === 1 ? "photograph" : "photographs"}`,
      targetShelf: album.album_id,
    }));
}

function thingsGroup(term: string, assets: readonly Asset[]): SearchGroupHit[] {
  const counts = new Map<string, number>();
  for (const asset of assets) {
    for (const tag of asset.tags ?? []) {
      if (!matches(term, tag.label)) continue;
      counts.set(tag.label, (counts.get(tag.label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .slice(0, MAX_PER_GROUP)
    .map(([label, count]) => ({
      kind: "things" as const,
      key: label,
      title: label,
      meta: `things · found in ${count} ${count === 1 ? "photograph" : "photographs"}`,
      targetShelf: `tag:${label}`,
    }));
}

/**
 * The grouped hits for a query, in the spec's own order: people, places,
 * albums, things. Empty for an empty query — resting has no hits to group.
 */
export function searchGroups({
  query,
  people,
  placeSections,
  albums,
  ownAssets,
  hits,
}: {
  query: string;
  people: readonly Person[];
  placeSections: readonly PlaceSection[];
  albums: readonly Album[];
  /** Own-scope assets, the same set People/Places/Albums membership reads
   *  (app-root.tsx's header) — a tag minted in one scope means nothing in
   *  another, exactly like an album id. */
  ownAssets: readonly Asset[];
  /** The loaded search hits, for the person row's "N here". */
  hits: readonly Asset[];
}): SearchGroupHit[] {
  const term = query.trim().toLowerCase();
  if (!term) return [];
  return [
    ...personGroup(term, people, hits),
    ...placeGroup(term, placeSections),
    ...albumGroup(term, albums),
    ...thingsGroup(term, ownAssets),
  ];
}

/** Which shelf-copy noun a group's `Open →` announces, for a screen reader
 *  label — kept here so the row's own accessible name stays in step with
 *  the shelf it navigates to. */
export function searchGroupOpenLabel(hit: SearchGroupHit): string {
  return `Open ${hit.title}`;
}
