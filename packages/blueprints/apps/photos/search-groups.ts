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
import { NO_LOCATION_KEY } from "./components/Places.tsx";
import type { PlaceSection } from "./components/Places.tsx";
import type { Person } from "./people.ts";
import { readableName } from "./place-map.ts";
import { distanceKm, homeBand, placePhrase } from "./place-phrase.ts";
import type { NamedPlace } from "./place-phrase.ts";
import { PLACE_HOME_TERMS, PLACE_NO_LOCATION_TERMS } from "./shared-copy.ts";
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

/**
 * WHAT A PLACE ANSWERS TO (#816).
 *
 * A place is a phrase, not a label, so it is findable by every phrase that is
 * honestly true of it — not only by the one string stored in its `name` column:
 *
 *  - the member's own name for it, when it has one ("the shore");
 *  - the settlement the gazetteer derived ("South Lake Tahoe, CA"), so "tahoe"
 *    finds a section a member called something else entirely;
 *  - the home vocabulary ("home", "near home", "at home"), for every place
 *    inside the "at home"/"around town" bands of the place the member DECLARED
 *    to be home — which is how a member who cannot recall the name of the park
 *    still finds the afternoon at it;
 *  - and the band's own words ("around town"), because that is the register the
 *    rest of the app phrases these in.
 *
 * A coordinate is NOT in the list. `readableName` drops the placeholder
 * `findOrCreatePlaceTx` mints, so typing "37.4" can never match a section, and
 * no hit can ever be titled with digits.
 */
function placeVocabulary(
  section: PlaceSection,
  home: NamedPlace | null
): string[] {
  if (section.key === NO_LOCATION_KEY) {
    return [section.name ?? "", ...PLACE_NO_LOCATION_TERMS];
  }
  const words: string[] = [];
  const member = readableName(section.name);
  if (member !== null) words.push(member);
  if (section.gazetteer) words.push(section.gazetteer);
  const band =
    home !== null && section.lat !== null && section.lng !== null
      ? homeBand(distanceKm(section.lat, section.lng, home.lat, home.lng))
      : null;
  // "away" is deliberately not searchable vocabulary: a photograph 200 km from
  // home is not near home in any register, and a query for "home" that
  // returned the holiday would be the opposite of an answer.
  if (band === "at home" || band === "around town") {
    words.push(...PLACE_HOME_TERMS, band);
  }
  return words;
}

/** The anchors a title's phrase may be relative to: the sections that carry a
 *  name a person would recognise AND a coordinate. Built from the sections
 *  themselves — the shelf already holds every place in the window, so search
 *  needs no second read to phrase one of them. */
function anchorsOf(sections: readonly PlaceSection[]): NamedPlace[] {
  return sections.flatMap((section) => {
    const name = readableName(section.name);
    if (name === null || section.lat === null || section.lng === null)
      return [];
    return [
      {
        key: section.key,
        name,
        lat: section.lat,
        lng: section.lng,
        ...(section.kind === "home" ? { isHome: true } : {}),
      },
    ];
  });
}

/** The one place the member declared to be home, or null. Search does NOT fall
 *  back to the busiest place or the modal coordinate: "near home" is a claim
 *  about a place a person named, and guessing which one it is would answer a
 *  question nobody asked. */
function homeAnchor(anchors: readonly NamedPlace[]): NamedPlace | null {
  return anchors.find((anchor) => anchor.isHome === true) ?? null;
}

function placeGroup(
  term: string,
  sections: readonly PlaceSection[]
): SearchGroupHit[] {
  const anchors = anchorsOf(sections);
  const home = homeAnchor(anchors);
  return sections
    .filter((section) =>
      placeVocabulary(section, home).some((word) => matches(term, word))
    )
    .slice(0, MAX_PER_GROUP)
    .map((section) => ({
      kind: "place" as const,
      key: section.key || "unnamed",
      // ALWAYS THE LADDER, never the column and never a coordinate: a section
      // matched by its gazetteer name or by "near home" still has to be titled
      // with something a person would say (`place-phrase.ts`).
      title: placePhrase({
        placeName: section.name,
        gazetteerName: section.gazetteer,
        lat: section.lat,
        lng: section.lng,
        namedPlaces: anchors,
        // A search result on the member's own screen, so the relative rung
        // stands. Stated rather than defaulted: a phrase that leaves the
        // device is built by `share-place.ts` and never by this call (#816).
        context: "private",
      }).text,
      meta: `place · ${section.assets.length} ${section.assets.length === 1 ? "photograph" : "photographs"}`,
      // Places has no per-place route yet (PLACES is one shelf of sections,
      // not N shelves) — Open lands on the shelf that shows this section, which
      // scrolls to it by its own key (`Places.tsx`'s `sectionDomId`).
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
