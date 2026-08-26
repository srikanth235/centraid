// The thirteen routes of Locker, the phone band's five slots, and the round
// trip between them (README-Locker §1).
//
// The structure — id model, route round trip, band tab — is
// `_shared/shelves.ts`, the same one Tasks, Docs and Photos navigate by,
// because Locker is a route inside the same frame and a member should not have
// to learn a second navigation model to reach a password. This file is
// Locker's TABLES.
//
// AND ONE TABLE THAT IS NOT A ROUTE: `suppressesNavigation`. The band, the
// rail and every list are withdrawn while locked, at setup, when denied and on
// the refused seat — not dimmed, not disabled, WITHDRAWN. A navigation spine
// standing over a locked vault would be advertising destinations that do not
// exist yet, which is the shape of a lie this app cannot afford.
import { createShelfRoutes } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

/** The first-run gate. Nothing is browsable before it (§6, First run). */
export const SETUP = "built-in:setup";
/** The lock screen, and the facts table about what a session is. */
export const LOCK = "built-in:lock";
/** One item — where reveal, conceal and copy live. */
export const ITEM = "built-in:item";
/** Add / edit. Online only, and it says so in the lede. */
export const EDIT = "built-in:edit";
/** The generator, a route of its own: someone who wants a string should not
 *  have to invent an item to get one. */
export const GEN = "built-in:gen";
/** Review — the verdicts, and the checks that cannot honestly run. */
export const WATCH = "built-in:watch";
/** Search: title, username and address, and it says what it does not search. */
export const SEARCH = "built-in:search";
export const IMPORT = "built-in:import";
export const ACCESS = "built-in:access";
export const TRASH = "built-in:trash";
export const EXPORT = "built-in:export";
/** The browser extension's surface — candidates, and why others were not. */
export const FILL = "built-in:fill";

/**
 * Every routed shelf, in the spec's own order. `null` is Items: `locker` IS
 * the item list, which is why it carries the empty segment rather than an
 * `items` one.
 */
export const LOCKER_SHELVES: readonly Shelf[] = [
  { id: SETUP, label: "First run", segment: "setup" },
  { id: LOCK, label: "Lock", segment: "lock" },
  { id: null, label: "Items", segment: "" },
  { id: ITEM, label: "Item", segment: "item" },
  { id: EDIT, label: "Add / edit", segment: "edit" },
  { id: GEN, label: "Generator", segment: "gen" },
  { id: WATCH, label: "Review", segment: "watch" },
  { id: SEARCH, label: "Search", segment: "search" },
  { id: IMPORT, label: "Import", segment: "import" },
  { id: ACCESS, label: "Access history", segment: "access" },
  { id: TRASH, label: "Trash", segment: "trash" },
  { id: EXPORT, label: "Export", segment: "export" },
  { id: FILL, label: "Companion", segment: "fill" },
];

/** The band's id for the root shelf, whose segment is empty. Accepted as a
 *  segment synonym too, so a band id round-trips. */
const ITEMS_ID = "items";

/**
 * The phone band Locker claims (§1): **Items · Review · Generate · Search**
 * plus the frame's More. Four destinations plus an act — Generate earns a slot
 * because it is the one thing in this app a member comes for without having an
 * item in mind, and everything behind More is a surface rather than a place.
 */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: ITEMS_ID, label: "Items", icon: "Lock" },
  { id: "watch", label: "Review", icon: "Shield" },
  { id: "gen", label: "Generate", icon: "Bolt" },
  { id: "search", label: "Search", icon: "Search" },
];

export const {
  countKey,
  shelfFromSegment,
  shelfSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId,
} = createShelfRoutes({
  route: "locker",
  routed: LOCKER_SHELVES,
  band: BAND_DESTINATIONS,
  rootBandId: ITEMS_ID,
});

/** The shelves reached from the band's More sheet, in the sheet's order. */
export const MORE_SHELVES: readonly ShelfId[] = [
  IMPORT,
  ACCESS,
  TRASH,
  EXPORT,
  FILL,
];

/**
 * The back row (§1, "Back to"). Every route above the root goes to the SAME
 * place — the item list — but it is named for what the member was doing:
 * backing out of one item returns to *Items*, while backing out of Trash or
 * the Access history returns to *Locker*, the app. `null` means no back row,
 * which is what a gate is.
 */
export function backRow(
  shelf: ShelfId
): { shelf: ShelfId; label: string } | null {
  if (shelf === SETUP || shelf === LOCK || shelf === null) return null;
  const label =
    shelf === ITEM || shelf === EDIT || shelf === GEN ? "Items" : "Locker";
  return { shelf: null, label };
}

/** The routes that draw the 232px rail (§1, the Rail column). The item, the
 *  editor and the export screen are single subjects: a rail beside one field
 *  set is a column of destinations nobody is going to. */
const RAILLESS: ReadonlySet<string> = new Set([
  SETUP,
  LOCK,
  ITEM,
  EDIT,
  EXPORT,
]);

export function showsRail(shelf: ShelfId): boolean {
  return shelf === null || !RAILLESS.has(shelf);
}

/** Does this route paint the ITEM ROW SET — the same rows under a filter? Only
 *  Items does; Review, Search and Trash draw their own registers over rows
 *  that carry a verdict, a match or a purge date. */
export function showsItems(shelf: ShelfId): boolean {
  return shelf === null;
}

/**
 * WHAT THE APP LOOKS LIKE WHEN THERE IS NOTHING TO NAVIGATE.
 *
 * Four conditions, and each is a different fact: the passphrase does not exist
 * yet, the session does not, the grant does not, or the seat itself refuses.
 * All four withdraw the band, the rail and every list — see the file header.
 */
export interface NavigationGate {
  /** No passphrase yet — the first-run gate is standing. */
  setup: boolean;
  /** A passphrase exists; no session does. */
  locked: boolean;
  /** The vault refused the read. Denial is DATA, and it is a screen. */
  denied: boolean;
  /** The seat itself refuses. The shell walls this before Root mounts, so
   *  Locker only ever sees `false` — the flag exists so the rule is stated in
   *  one place rather than assumed. */
  refused: boolean;
}

export function suppressesNavigation(gate: NavigationGate): boolean {
  return gate.setup || gate.locked || gate.denied || gate.refused;
}

/** Which route a gate forces, whatever the member last asked for. A locked
 *  vault is on the Lock screen, full stop — there is no "locked Items". */
export function gatedShelf(gate: NavigationGate, shelf: ShelfId): ShelfId {
  if (gate.setup) return SETUP;
  if (gate.locked) return LOCK;
  return shelf;
}

/** Which rail row and band tab a route lights. One item and the editor are
 *  sub-states of the list they were opened from, so they light *All items*
 *  rather than a row of their own; Export has no rail row at all and lights
 *  nothing, which is honest — it is reached from More. */
export function railShelf(shelf: ShelfId): ShelfId {
  return shelf === ITEM || shelf === EDIT ? null : shelf;
}
