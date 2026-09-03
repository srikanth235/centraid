import { createShelfRoutes, tokenFromShelf } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

export const BOOKS = "built-in:books";
export const JOURNAL = "built-in:journal";
export const SEARCH = "built-in:search";
export const NOTE = "built-in:note";
export const HISTORY = "built-in:history";
export const TAGS = "built-in:tags";
export const TRASH = "built-in:trash";
export const CAPTURE = "built-in:capture";
export const VOICE = "built-in:voice";

const NOTEBOOK_PREFIX = "notebook:";

export function notebookShelf(notebookId: string): string {
  return `${NOTEBOOK_PREFIX}${notebookId}`;
}

export function notebookIdFrom(id: ShelfId): string | null {
  return tokenFromShelf(NOTEBOOK_PREFIX, id);
}

const ROUTED: readonly Shelf[] = [
  { id: null, label: "Library", segment: "" },
  { id: BOOKS, label: "Notebooks", segment: "books" },
  { id: JOURNAL, label: "Journal", segment: "journal" },
  { id: SEARCH, label: "Search", segment: "search" },
  { id: NOTE, label: "Note", segment: "note" },
  { id: HISTORY, label: "Version history", segment: "history" },
  { id: TAGS, label: "Tags", segment: "tags" },
  { id: TRASH, label: "Trash", segment: "trash" },
  { id: CAPTURE, label: "Capture", segment: "capture" },
  { id: VOICE, label: "Voice", segment: "voice" },
];

const LIBRARY_ID = "library";

export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: LIBRARY_ID, label: "Library" },
  { id: "books", label: "Notebooks" },
  { id: "journal", label: "Journal" },
  { id: "search", label: "Search" },
];

export const MORE_SHELVES: readonly ShelfId[] = [
  CAPTURE,
  VOICE,
  TAGS,
  TRASH,
  HISTORY,
];

export const {
  shelfFromSegment,
  shelfSegment,
  shelfRoute,
  shelfFromRoute,
  bandActiveId,
} = createShelfRoutes({
  route: "notes",
  routed: ROUTED,
  band: BAND_DESTINATIONS,
  rootBandId: LIBRARY_ID,
  dynamic: {
    idPrefix: NOTEBOOK_PREFIX,
    segmentPrefix: "notebook/",
    fallback: BOOKS,
    bandKey: LIBRARY_ID,
  },
});

export function showsLibrary(id: ShelfId): boolean {
  return id === null || notebookIdFrom(id) !== null;
}

export function showsViewToggle(id: ShelfId): boolean {
  return showsLibrary(id) || id === JOURNAL || id === SEARCH;
}

export function isEditing(id: ShelfId): boolean {
  return id === NOTE;
}
