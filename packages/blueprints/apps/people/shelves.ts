import { createShelfRoutes } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

export const TOUCH = "built-in:touch";
export const SEARCH = "built-in:search";
export const PERSON = "built-in:person";
export const LOG = "built-in:log";
export const EDIT = "built-in:edit";
export const TRASH = "built-in:trash";
export const MERGE = "built-in:merge";

const ROSTER_ID = "people";

const ROUTED: readonly Shelf[] = [
  { id: null, label: "People", segment: "" },
  { id: TOUCH, label: "Touch", segment: "touch" },
  { id: SEARCH, label: "Search", segment: "search" },
  { id: PERSON, label: "Person", segment: "person" },
  { id: LOG, label: "Log a touch", segment: "log" },
  { id: EDIT, label: "Edit", segment: "edit" },
  { id: TRASH, label: "Trash", segment: "trash" },
  { id: MERGE, label: "Merge", segment: "merge" },
];

export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: ROSTER_ID, label: "People", icon: "Users" },
  { id: "touch", label: "Touch", icon: "Clock" },
  { id: "search", label: "Search", icon: "Search" },
];

export const DESTINATION_SHELVES: readonly Shelf[] = [
  { id: null, label: "People", segment: "" },
  { id: TOUCH, label: "Touch", segment: "touch" },
  { id: SEARCH, label: "Search", segment: "search" },
];

const NESTED: ReadonlySet<string> = new Set([PERSON, LOG, EDIT, TRASH, MERGE]);

export function isNested(id: ShelfId): boolean {
  return typeof id === "string" && NESTED.has(id);
}

export function originShelf(id: ShelfId): ShelfId {
  return isNested(id) ? null : id;
}

export const {
  shelfFromSegment,
  shelfSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId,
} = createShelfRoutes({
  route: "people",
  routed: ROUTED,
  band: BAND_DESTINATIONS,
  rootBandId: ROSTER_ID,
});

export function bandTabFor(id: ShelfId): string | undefined {
  return bandActiveId(originShelf(id));
}
