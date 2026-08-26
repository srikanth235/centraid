// Docs' shelf TABLES; structure lives in `_shared/shelves.ts`. THE ROUTE ID
// IS `docs`, never `dx` — `docs` is the installed app and manifest id.
import { createShelfRoutes, tokenFromShelf } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

// `built-in:` cannot collide with a folder id, which never carries a colon.
export const FOLDERS = "built-in:folders";
export const RECENT = "built-in:recent";
export const STARRED = "built-in:starred";
export const TRASH = "built-in:trash";
export const SEARCH = "built-in:search";
export const STORAGE = "built-in:storage";
export const NEWDOC = "built-in:newdoc";
export const SCAN = "built-in:scan";
export const CAPABILITIES = "built-in:capabilities";
export const FILING = "built-in:filing";
export const NAMES = "built-in:names";
export const LOCKER = "built-in:locker";

const FOLDER_PREFIX = "folder:";

export function folderShelf(folderId: string): string {
  return `${FOLDER_PREFIX}${folderId}`;
}

export function folderIdFrom(id: ShelfId): string | null {
  return tokenFromShelf(FOLDER_PREFIX, id);
}

/** Search, Storage, Add and Scan are deliberately absent: not tabs. */
export const DSHELVES: readonly Shelf[] = [
  { id: null, label: "All", segment: "" },
  { id: FOLDERS, label: "Folders", segment: "folders" },
  { id: RECENT, label: "Recently changed", segment: "recent" },
  { id: STARRED, label: "Starred", segment: "starred" },
  { id: TRASH, label: "Trash", segment: "trash" },
];

const ROUTED: readonly Shelf[] = [
  ...DSHELVES,
  { id: SEARCH, label: "Search", segment: "search" },
  { id: STORAGE, label: "Storage", segment: "storage" },
  { id: NEWDOC, label: "Add a document", segment: "newdoc" },
  { id: SCAN, label: "Scan a document", segment: "scan" },
  { id: CAPABILITIES, label: "What Docs may read", segment: "capabilities" },
  { id: FILING, label: "Proposed filing", segment: "filing" },
  { id: NAMES, label: "Who your documents name", segment: "names" },
  { id: LOCKER, label: "Docs and Locker", segment: "locker" },
];

const ALL_ID = "list";

/** A CAP but no floor: never invent a tab. `grid` is a view of All. */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: ALL_ID, label: "All" },
  { id: "folders", label: "Folders" },
  { id: "search", label: "Search" },
];

export const {
  countKey,
  shelfFromSegment,
  shelfSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId,
} = createShelfRoutes({
  route: "docs",
  routed: ROUTED,
  band: BAND_DESTINATIONS,
  rootBandId: ALL_ID,
  dynamic: {
    idPrefix: FOLDER_PREFIX,
    segmentPrefix: "folder/",
    fallback: FOLDERS,
    bandKey: "folders",
  },
});

export function stripShelf(id: ShelfId): ShelfId {
  if (folderIdFrom(id)) return FOLDERS;
  return DSHELVES.some((shelf) => shelf.id === id) ? id : null;
}

const NON_DRIVE: ReadonlySet<string> = new Set([
  FOLDERS,
  STORAGE,
  NEWDOC,
  SCAN,
  CAPABILITIES,
  FILING,
  NAMES,
  LOCKER,
]);

export function showsDrive(id: ShelfId): boolean {
  if (folderIdFrom(id)) return true;
  return id === null || !NON_DRIVE.has(id);
}

/** NOT `showsDrive`: Folders paints a set too. */
export function showsViewToggle(id: ShelfId): boolean {
  return showsDrive(id) || id === FOLDERS;
}

export function allowsSelection(id: ShelfId): boolean {
  return showsDrive(id);
}

export function isTrash(id: ShelfId): boolean {
  return id === TRASH;
}
