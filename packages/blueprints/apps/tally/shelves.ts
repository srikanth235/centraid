import { createShelfRoutes } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

export const ACTIVITY = "built-in:activity";
export const GROUPS = "built-in:groups";
export const GROUP = "built-in:group";
export const FRIEND = "built-in:friend";
export const EXPENSE = "built-in:expense";
export const ADD = "built-in:add";
export const RECEIPT = "built-in:receipt";
export const SETTLE = "built-in:settle";
export const RECURRING = "built-in:recurring";
export const WAITING = "built-in:contrib";
export const SPENDING = "built-in:insight";
export const TRASH = "built-in:trash";
export const SEARCH = "built-in:search";
export const EXPORT = "built-in:export";

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

const BALANCES_ID = "balances";

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

export const MORE_SHELVES: readonly ShelfId[] = [
  RECURRING,
  SPENDING,
  SEARCH,
  TRASH,
  EXPORT,
];

const BAND_SLOT: ReadonlyMap<string, ShelfId> = new Map<string, ShelfId>([
  [String(GROUP), GROUPS],
  [String(FRIEND), null],
  [String(EXPENSE), ACTIVITY],
  [String(ADD), ACTIVITY],
  [String(RECEIPT), ACTIVITY],
  [String(SETTLE), null],
]);

export function bandShelf(id: ShelfId): ShelfId {
  const slot = BAND_SLOT.get(String(id));
  return slot === undefined ? id : slot;
}

export function bandActiveId(id: ShelfId): string | undefined {
  return bandIdForShelf(bandShelf(id));
}

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

export function shelfLabel(id: ShelfId): string {
  return TALLY_SHELVES.find((shelf) => shelf.id === id)?.label ?? "Balances";
}
