// The fifteen routes of the Tally room, the compact band's four destinations,
// and the route round trip (Tally spec §1).
//
// The structure — id model, route round trip, band tab — is
// `_shared/shelves.ts`, because Tally is a route inside the same frame Tasks,
// Docs and Photos are routes inside, and a member should not have to learn a
// fifth navigation model. This file is Tally's TABLES.
//
// NO DYNAMIC SHELF FAMILY, and that is the spec's own shape rather than a
// simplification: `tally/group` and `tally/friend` are two SINGULAR routes,
// each standing over whichever group or friend the member opened. The shared
// round trip carries one dynamic family, Tally would need two, and the spec's
// route table names exactly fifteen — so which group is open is app state
// beside the route, not a sixteenth and seventeenth route.
import { createShelfRoutes } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

// The `built-in:` prefix can never collide with a vault id, which is an opaque
// token carrying no colon — the one-slot trick `tasks/shelves.ts` uses.
export const ACTIVITY = "built-in:activity";
export const GROUPS = "built-in:groups";
/** One group's ledger — its members, their nets, and its expenses. */
export const GROUP = "built-in:group";
/** One friend's net, with every part of it openable. */
export const FRIEND = "built-in:friend";
export const EXPENSE = "built-in:expense";
export const ADD = "built-in:add";
export const RECEIPT = "built-in:receipt";
export const SETTLE = "built-in:settle";
export const RECURRING = "built-in:recurring";
/** The multi-writer surface — the only place a write can be somebody else's
 *  and stuck, which is why it holds a band slot. */
export const WAITING = "built-in:contrib";
export const SPENDING = "built-in:insight";
export const TRASH = "built-in:trash";
export const SEARCH = "built-in:search";
export const EXPORT = "built-in:export";

/**
 * Every routed shelf, in the spec's own order. `null` is Balances: `tally` IS
 * Balances, which is why it carries the empty segment rather than a `balances`
 * one.
 */
export const TALLY_SHELVES: readonly Shelf[] = [
  { id: null, label: "Balances", segment: "" },
  { id: ACTIVITY, label: "Activity", segment: "activity" },
  { id: GROUPS, label: "Groups", segment: "groups" },
  { id: GROUP, label: "Group ledger", segment: "group" },
  { id: FRIEND, label: "Friend", segment: "friend" },
  { id: EXPENSE, label: "Expense", segment: "expense" },
  { id: ADD, label: "Add expense", segment: "add" },
  { id: RECEIPT, label: "Receipt", segment: "receipt" },
  { id: SETTLE, label: "Settle up", segment: "settle" },
  { id: RECURRING, label: "Recurring", segment: "recurring" },
  { id: WAITING, label: "Waiting", segment: "contrib" },
  { id: SPENDING, label: "Spending", segment: "insight" },
  { id: TRASH, label: "Trash", segment: "trash" },
  { id: SEARCH, label: "Search", segment: "search" },
  { id: EXPORT, label: "Export", segment: "export" },
];

/** The band's id for the root shelf, whose segment is empty. Accepted as a
 *  segment synonym too, so a band id round-trips. */
const BALANCES_ID = "balances";

/**
 * The band Tally claims (§1): four PLACES plus More. Waiting earns a slot
 * because it is the only place in Tally where a write can be somebody else's
 * and stuck, and there is nowhere else to look for it.
 *
 * NO COUNT IN THE BAND. A queue with a number on it is a badge, and a badge is
 * the one thing this product does not draw — Waiting says how many when the
 * member is standing in it.
 */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: BALANCES_ID, label: "Balances", icon: "Coin" },
  { id: "activity", label: "Activity", icon: "Activity" },
  { id: "groups", label: "Groups", icon: "Users" },
  { id: "contrib", label: "Waiting", icon: "Clock" },
];

export const {
  shelfFromSegment,
  shelfSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId: bandIdForShelf,
} = createShelfRoutes({
  route: "tally",
  routed: TALLY_SHELVES,
  band: BAND_DESTINATIONS,
  rootBandId: BALANCES_ID,
});

/** The shelves reached from the band's More sheet, in the sheet's order —
 *  lenses and acts, never places. */
export const MORE_SHELVES: readonly ShelfId[] = [
  RECURRING,
  SPENDING,
  SEARCH,
  TRASH,
  EXPORT,
];

/**
 * Which BAND SLOT a shelf belongs to — the spec's own "Band slot" column. A
 * group ledger lights Groups because that is where the member reached it from;
 * a friend, an expense and the editors light the shelf they came out of; every
 * lens and act lights nothing, and sits behind More.
 */
const BAND_SLOT: ReadonlyMap<string, ShelfId> = new Map<string, ShelfId>([
  [String(GROUP), GROUPS],
  [String(FRIEND), null],
  [String(EXPENSE), ACTIVITY],
  [String(ADD), ACTIVITY],
  [String(RECEIPT), ACTIVITY],
  [String(SETTLE), null],
]);

/** The shelf whose band tab and rail row a route lights. */
export function bandShelf(id: ShelfId): ShelfId {
  const slot = BAND_SLOT.get(String(id));
  return slot === undefined ? id : slot;
}

/** Which band tab is lit for a shelf, or undefined for a lens behind More. */
export function bandActiveId(id: ShelfId): string | undefined {
  return bandIdForShelf(bandShelf(id));
}

/**
 * Does this route paint a LIST over the ledger — the shelves the 232px rail
 * stands beside? The editors, the expense and the receipt each fill the pane
 * with one thing, so the rail is withdrawn rather than left pointing at a
 * place the member is no longer in.
 */
const LIST_SHELVES: ReadonlySet<string> = new Set([
  String(null),
  ACTIVITY,
  GROUPS,
  GROUP,
  FRIEND,
  RECURRING,
  WAITING,
  SPENDING,
  TRASH,
  SEARCH,
]);

export function showsLedgerList(id: ShelfId): boolean {
  return LIST_SHELVES.has(String(id));
}

/**
 * Where the route's back row leads, and what it is CALLED there (§1's "Back
 * to" column).
 *
 * The label is the destination, not the word "Back": a member who descended
 * into a group ledger backs out to *Groups*, and one who opened a lens backs
 * out to *Tally* — the app itself, which is what the ledger's root is called
 * from a lens. A route absent from this table is a place the member arrived
 * at rather than descended into, and draws no back row at all.
 */
export interface BackDestination {
  shelf: ShelfId;
  label: string;
}

const APP_NAME = "Tally";

const BACK_TO: ReadonlyMap<string, BackDestination> = new Map<
  string,
  BackDestination
>([
  [String(GROUP), { shelf: GROUPS, label: "Groups" }],
  [String(FRIEND), { shelf: null, label: "Balances" }],
  [String(EXPENSE), { shelf: ACTIVITY, label: "Activity" }],
  [String(ADD), { shelf: ACTIVITY, label: "Activity" }],
  [String(RECEIPT), { shelf: ACTIVITY, label: "Activity" }],
  [String(SETTLE), { shelf: null, label: "Balances" }],
  [String(RECURRING), { shelf: null, label: APP_NAME }],
  [String(WAITING), { shelf: null, label: APP_NAME }],
  [String(SPENDING), { shelf: null, label: APP_NAME }],
  [String(TRASH), { shelf: null, label: APP_NAME }],
  [String(SEARCH), { shelf: null, label: APP_NAME }],
  [String(EXPORT), { shelf: GROUPS, label: "Groups" }],
]);

export function backShelf(id: ShelfId): BackDestination | undefined {
  return BACK_TO.get(String(id));
}

/** The shelf's own name, as the bar and the back row spell it. */
export function shelfLabel(id: ShelfId): string {
  return TALLY_SHELVES.find((shelf) => shelf.id === id)?.label ?? "Balances";
}
