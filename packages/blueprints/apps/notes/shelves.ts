// The ten Notes routes, the compact band's five destinations, and the round
// trip between them (Notes spec §1, §2).
//
// The structure — id model, `notes`/`notes/<sub>` round trip, band tab — is
// `_shared/shelves.ts`, the same module Docs and Photos navigate by: three
// routes inside one frame, one navigation model. This file is Notes' TABLES.
import { createShelfRoutes, tokenFromShelf } from "../_shared/shelves.ts";
import type { BandDestination, Shelf, ShelfId } from "../_shared/shelves.ts";

export type { Shelf, ShelfId } from "../_shared/shelves.ts";

/** Notebooks — the spine. A note lives in one of these or in none. */
export const BOOKS = "built-in:books";
/** The Journal place: a filter over the People-journal scheme, never an
 *  interleave into the library (spec §1's fourth ruling). */
export const JOURNAL = "built-in:journal";
export const SEARCH = "built-in:search";
/** The editor. A note is a destination, not an overlay over the library. */
export const NOTE = "built-in:note";
/** The version chain, newest first — a standing surface, not a menu item. */
export const HISTORY = "built-in:history";
/** Tags — the lens. Never a place a note lives. */
export const TAGS = "built-in:tags";
export const TRASH = "built-in:trash";
/** The two ORIGIN ACTS. Content born on a device cannot be born on a seat
 *  with no camera or microphone in the member's hand (§1), so both routes
 *  exist everywhere and each says what this seat can do. */
export const CAPTURE = "built-in:capture";
export const VOICE = "built-in:voice";

/** One notebook's own sub-state of the library: the same window under a
 *  filter, exactly as one folder is in Docs. */
const NOTEBOOK_PREFIX = "notebook:";

/** The shelf id for one notebook, from its notebook id. */
export function notebookShelf(notebookId: string): string {
  return `${NOTEBOOK_PREFIX}${notebookId}`;
}

/** The notebook id behind a notebook shelf, or null for any other shelf. */
export function notebookIdFrom(id: ShelfId): string | null {
  return tokenFromShelf(NOTEBOOK_PREFIX, id);
}

/** Every routed shelf, in the order the spec's screen inventory lists them. */
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

/**
 * The library's own band id. `notes` IS the library, so its segment is empty
 * — but a band tab and an `aria-current` key need a non-empty id, and the
 * band says `Library`.
 */
const LIBRARY_ID = "library";

/**
 * The band Notes claims on its own routes (§2), plus More. FIVE
 * DESTINATIONS AND NOT SIX: only a PLACE is in the band. Capture, Voice,
 * Tags, Trash and Version history are acts, and an act behind More is still
 * one tap from anywhere.
 */
export const BAND_DESTINATIONS: readonly BandDestination[] = [
  { id: LIBRARY_ID, label: "Library" },
  { id: "books", label: "Notebooks" },
  { id: "journal", label: "Journal" },
  { id: "search", label: "Search" },
];

/** The routes reached through the band's sixth slot (§2). */
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
    // One notebook lights **Library**: it is the library under a filter, and
    // the member reached it as a way of narrowing the reading room rather
    // than as a second place.
    bandKey: LIBRARY_ID,
  },
});

/** The shelves that paint the LIBRARY's own row set — cards or rows over the
 *  same window. Journal paints the same shape over a different set, so it is
 *  deliberately not one of them: its rows come from its own query. */
export function showsLibrary(id: ShelfId): boolean {
  return id === null || notebookIdFrom(id) !== null;
}

/** May the cards/list pair mean anything here? Wherever a set of notes is
 *  drawn — the library, one notebook, the Journal place and the results. */
export function showsViewToggle(id: ShelfId): boolean {
  return showsLibrary(id) || id === JOURNAL || id === SEARCH;
}

/** Is this route the editor's context? The app bar's one filled control is
 *  **Link** there and **New note** everywhere else. */
export function isEditing(id: ShelfId): boolean {
  return id === NOTE;
}
