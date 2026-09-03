import { createShelfRoutes, tokenFromShelf } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";
import type { SelectionShelfKind } from "./components/SelectionBar.tsx";
import { ALBUMS, DUPLICATES, FAVORITES, TRASH } from "./constants.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

export const PLACES = "built-in:places";
export const PEOPLE = "built-in:people";
export const SEARCH = "built-in:search";
export const STORAGE = "built-in:storage";

const PERSON_PREFIX = "person:";

export function personShelf(partyId: string): string {
  return `${PERSON_PREFIX}${partyId}`;
}

export function personIdFrom(id: ShelfId): string | null {
  return tokenFromShelf(PERSON_PREFIX, id);
}

export const SHELVES: readonly Shelf[] = [
  { id: null, label: "Library", segment: "" },
  { id: FAVORITES, label: "Favorites", segment: "favorites" },
  { id: ALBUMS, label: "Albums", segment: "albums" },
  { id: PLACES, label: "Places", segment: "places" },
  { id: PEOPLE, label: "People", segment: "people" },
  { id: DUPLICATES, label: "Duplicates", segment: "duplicates" },
  { id: TRASH, label: "Trash", segment: "trash" },
];

const ROUTED: readonly Shelf[] = [
  ...SHELVES,
  { id: SEARCH, label: "Search", segment: "search" },
  { id: STORAGE, label: "Storage", segment: "storage" },
];

export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: "library", label: "Library", icon: "Image" },
  { id: "albums", label: "Albums", icon: "album" },
  { id: "people", label: "People", icon: "person" },
  { id: "search", label: "Search", icon: "Search" },
];

export const MORE_DESTINATIONS: readonly Shelf[] = [
  ...SHELVES.filter(
    (shelf) =>
      shelf.id !== null &&
      !BAND_DESTINATIONS.some((dest) => dest.id === shelf.segment)
  ),
  { id: STORAGE, label: "Storage", segment: "storage" },
];

export const {
  countKey,
  shelfFromSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId,
} = createShelfRoutes({
  route: "photos",
  routed: ROUTED,
  band: BAND_DESTINATIONS,
  rootBandId: "library",
});

const NON_TIMELINE: ReadonlySet<string> = new Set([
  ALBUMS,
  PLACES,
  PEOPLE,
  DUPLICATES,
  SEARCH,
  STORAGE,
]);

export function showsTimeline(id: ShelfId): boolean {
  return id === null || !NON_TIMELINE.has(id);
}

export function packsTiles(id: ShelfId): boolean {
  return showsTimeline(id) || id === PLACES;
}

export function showsTileSize(id: ShelfId): boolean {
  return packsTiles(id);
}

export function allowsSelection(id: ShelfId): boolean {
  return packsTiles(id);
}

export function shelfKindFor(id: ShelfId): SelectionShelfKind {
  return id === TRASH ? "trash" : "normal";
}
