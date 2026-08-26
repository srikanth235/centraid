// People's tables over `_shared/shelves.ts`, which owns the id model, the
// `people` / `people/<sub>` round trip and the band's active tab.
//
// Nested screens carry no id: the person is `AppState.personId`, so do not add
// a `people/person/<id>` family. Share, Vault link and the vault sections of
// person/edit have no segment — no query answers the vault-link system (see
// people-copy.ts), and a route to an unbuildable screen is worse than none.
import { createShelfRoutes } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

export const TOUCH = "built-in:touch";
/** A destination, not a field on the roster (handoff deviation 1). */
export const SEARCH = "built-in:search";
export const PERSON = "built-in:person";
export const LOG = "built-in:log";
export const EDIT = "built-in:edit";
/** Restore only; the product has no destroy verb. */
export const TRASH = "built-in:trash";
export const MERGE = "built-in:merge";

/** Empty segment, also accepted as a segment synonym so a band id round-trips. */
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

/** Three, where the platform rule asks for four (handoff deviation 2). Icons
 *  are shared-registry keys; an unknown key just draws no glyph. */
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

/** Which destination stays lit under a nested screen — the one line to change
 *  the day one hangs off Touch. */
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
