import { createShelfRoutes } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

export const SETUP = "built-in:setup";
export const LOCK = "built-in:lock";
export const ITEM = "built-in:item";
export const EDIT = "built-in:edit";
export const GEN = "built-in:gen";
export const WATCH = "built-in:watch";
export const SEARCH = "built-in:search";
export const IMPORT = "built-in:import";
export const ACCESS = "built-in:access";
export const TRASH = "built-in:trash";
export const EXPORT = "built-in:export";
export const FILL = "built-in:fill";

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

const ITEMS_ID = "items";

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

export const MORE_SHELVES: readonly ShelfId[] = [
  IMPORT,
  ACCESS,
  TRASH,
  EXPORT,
  FILL,
];

export function backRow(
  shelf: ShelfId
): { shelf: ShelfId; label: string } | null {
  if (shelf === SETUP || shelf === LOCK || shelf === null) return null;
  const label =
    shelf === ITEM || shelf === EDIT || shelf === GEN ? "Items" : "Locker";
  return { shelf: null, label };
}

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

export function showsItems(shelf: ShelfId): boolean {
  return shelf === null;
}

export interface NavigationGate {
  setup: boolean;
  locked: boolean;
  denied: boolean;
  refused: boolean;
}

export function suppressesNavigation(gate: NavigationGate): boolean {
  return gate.setup || gate.locked || gate.denied || gate.refused;
}

export function gatedShelf(gate: NavigationGate, shelf: ShelfId): ShelfId {
  if (gate.setup) return SETUP;
  if (gate.locked) return LOCK;
  return shelf;
}

export function railShelf(shelf: ShelfId): ShelfId {
  return shelf === ITEM || shelf === EDIT ? null : shelf;
}
