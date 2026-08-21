// People's route model: three band destinations and five nested screens
// (v12 handoff § Screens, § Navigation).
//
// The STRUCTURE — the id model, the `people` / `people/<sub>` round trip, the
// band's active tab — is `_shared/shelves.ts`, exactly as Docs and Photos use
// it. This file is People's TABLES.
//
// THE NESTED SCREENS CARRY NO ID IN THE ROUTE. A person, a log composer, an
// editor and a merge are all ABOUT one person, and that person is a single
// piece of app state (`AppState.personId`) rather than five copies of the same
// token spread across five segments. The handoff's own rule is that the round
// trip is `people` or `people/<sub>`; a `people/person/<id>` family would have
// been a second navigation model for the same one destination.
//
// FIVE SCREENS THE HANDOFF DRAWS ARE NOT HERE: Share, Vault link, and the
// vault sections of the person and edit screens. They navigate the vault-link
// system, which no query answers (see people-copy.ts). A route to a screen
// that cannot be built is a promise the app cannot keep, so the segment does
// not exist rather than resolving to a placeholder.
import { createShelfRoutes } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

/** Keep in touch — what needs doing about people, in priority order. */
export const TOUCH = "built-in:touch";
/** Search is a DESTINATION, not a field on the roster (handoff deviation 1). */
export const SEARCH = "built-in:search";
/** One person, one level deep. `AppState.personId` says which. */
export const PERSON = "built-in:person";
/** The log composer — three decisions and no scrolling. */
export const LOG = "built-in:log";
/** Edit an existing person, or compose a new one. */
export const EDIT = "built-in:edit";
/** Thirty-day restore. There is no destroy verb anywhere in the product. */
export const TRASH = "built-in:trash";
/** Merge a duplicate into the person on screen. */
export const MERGE = "built-in:merge";

/** The band's id for the roster, whose segment is empty (`people` IS the
 *  roster). Accepted as a segment synonym too, so a band id round-trips. */
const ROSTER_ID = "people";

/** Every shelf with a route segment. The roster is the app's root. */
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

/**
 * The three destinations People claims the phone's band with (handoff
 * deviation 2 — three, where the platform rule asks for four, because each
 * holds distinct work and the alternative is a segmented control the thumb
 * cannot reach). Icons are shared-registry keys: an unknown key draws no glyph
 * and the label still names the tab.
 */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: ROSTER_ID, label: "People", icon: "Users" },
  { id: "touch", label: "Touch", icon: "Clock" },
  { id: "search", label: "Search", icon: "Search" },
];

/** The three shelves that ARE destinations, in band order — what the pointer
 *  surface's segmented control draws. */
export const DESTINATION_SHELVES: readonly Shelf[] = [
  { id: null, label: "People", segment: "" },
  { id: TOUCH, label: "Touch", segment: "touch" },
  { id: SEARCH, label: "Search", segment: "search" },
];

const NESTED: ReadonlySet<string> = new Set([PERSON, LOG, EDIT, TRASH, MERGE]);

/** Is this screen one level deep — the frame's back row, no destination of its
 *  own? Asked by the chrome, the app bar and the band claim, so the answer
 *  cannot be spelled three ways. */
export function isNested(id: ShelfId): boolean {
  return typeof id === "string" && NESTED.has(id);
}

/**
 * Which destination a nested screen was reached FROM, and therefore which tab
 * stays lit while it is open. Log is reached from either the person screen or
 * a Reconnect row, and both of those live under People once the person screen
 * is open — so every nested screen lights People. Stated as a function rather
 * than assumed, because the day a nested screen hangs off Touch this is the
 * one line that changes.
 */
export function originShelf(id: ShelfId): ShelfId {
  return isNested(id) ? null : id;
}

/** The route round trip and the band's active tab: `people` or
 *  `people/<sub>`, one destination either way. */
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

/** The band tab lit for a shelf — a nested screen keeps its origin's tab
 *  rather than dropping the band's highlight entirely. */
export function bandTabFor(id: ShelfId): string | undefined {
  return bandActiveId(originShelf(id));
}
