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

export type SearchGroupKind = "person" | "place" | "album" | "things";

export interface SearchGroupHit {
  kind: SearchGroupKind;
  key: string;
  title: string;
  meta: string;
  here?: string;
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
  if (band === "at home" || band === "around town") {
    words.push(...PLACE_HOME_TERMS, band);
  }
  return words;
}

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
      title: placePhrase({
        placeName: section.name,
        gazetteerName: section.gazetteer,
        lat: section.lat,
        lng: section.lng,
        namedPlaces: anchors,
        context: "private",
      }).text,
      meta: `place · ${section.assets.length} ${section.assets.length === 1 ? "photograph" : "photographs"}`,
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
  ownAssets: readonly Asset[];
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

export function searchGroupOpenLabel(hit: SearchGroupHit): string {
  return `Open ${hit.title}`;
}
