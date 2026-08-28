// The phone's bottom band, as Notes claims it (#882): four PLACES plus More —
// the frame's exact cap. Capture, Voice, Tags, Trash and Version history are
// ACTS, and acts sit behind More.
//
// Ids, labels and order come from the web app's shelf tables
// (`blueprints/apps/notes/shelves.ts`), so band, rail and app bar cannot
// disagree; `bandActiveId` is what decides which tab a shelf lights, which is
// why a notebook lights Library rather than becoming a sixth place. No
// `react-native` imports: `notes-band.test.ts` asserts these rules as values
// and `NotesBand.tsx` renders them unchanged.

import {
  BAND_DESTINATIONS,
  MORE_SHELVES,
  bandActiveId,
} from "@centraid/blueprints/apps/notes/shelves";
import type { ShelfId } from "@centraid/blueprints/apps/notes/shelves";
import {
  captionFor,
  shelfCopy,
} from "@centraid/blueprints/apps/notes/view-copy";

import type { BandOwner } from "../../kit/band/band-owner";

export type NotesBandDestinationKey =
  | "library"
  | "books"
  | "journal"
  | "search"
  | "more";

export interface NotesBandDestination {
  key: NotesBandDestinationKey;
  /** The web app's word for this place, never a second spelling. */
  label: string;
  icon: string;
}

/** Frame band's cap, hence a claiming app's: five destinations, fifth = More. */
export const NOTES_BAND_MAX_DESTINATIONS = 5;

export const NOTES_BAND_CAPSULE_SIZE = 52;

const BAND_ICONS: Readonly<Record<NotesBandDestinationKey, string>> = {
  library: "FileText",
  books: "Book",
  journal: "Journal",
  search: "Search",
  more: "more-vertical",
};

export const NOTES_BAND_DESTINATIONS: readonly NotesBandDestination[] = [
  ...BAND_DESTINATIONS.map((destination) => ({
    key: destination.id as NotesBandDestinationKey,
    label: destination.label,
    icon: BAND_ICONS[destination.id as NotesBandDestinationKey],
  })),
  { key: "more", label: "More", icon: BAND_ICONS.more },
];

/** The frame's capsule — a frame control, never one of the app's tabs. */
export interface NotesBandCapsule {
  label: "Home";
  icon: "Home";
  size: number;
  edge: "leading";
  /** The seam. `false` is the whole reason it is not a sixth tab. */
  inTabGroup: false;
}

export const NOTES_BAND_CAPSULE: NotesBandCapsule = {
  label: "Home",
  icon: "Home",
  size: NOTES_BAND_CAPSULE_SIZE,
  edge: "leading",
  inTabGroup: false,
};

/** Exactly one band exists at any moment — the frame's latch. */
export type ResolvedNotesBand =
  | {
      owner: "app";
      destinations: readonly NotesBandDestination[];
      capsule: NotesBandCapsule;
    }
  | { owner: "host" };

export function resolveNotesBand(owner: BandOwner): ResolvedNotesBand {
  if (owner === "host") return { owner: "host" };
  if (NOTES_BAND_DESTINATIONS.length > NOTES_BAND_MAX_DESTINATIONS) {
    throw new Error(
      `Notes claimed ${NOTES_BAND_DESTINATIONS.length} band destinations; the cap is ${NOTES_BAND_MAX_DESTINATIONS}`
    );
  }
  return {
    owner: "app",
    destinations: NOTES_BAND_DESTINATIONS,
    capsule: NOTES_BAND_CAPSULE,
  };
}

/** The sheet is where a member stands while choosing an act — it is not a
 *  shelf, so it may not be spelled as one. */
export const NOTES_MORE_SHEET = "sheet:more";

/** Where the cover stands: any shelf the web routes, or the More sheet. */
export type NotesPlace = ShelfId | typeof NOTES_MORE_SHEET;

const BAND_KEYS = new Set(BAND_DESTINATIONS.map((entry) => entry.id));

/**
 * Which tab lights. A shelf the band has no room for (Tags, Trash, Version
 * history, Capture, Voice, an open note) lights More — the sheet is how the
 * member got there, and lighting one of the other four would point at a place
 * they are not looking at.
 */
export function notesBandKeyFor(place: NotesPlace): NotesBandDestinationKey {
  if (place === NOTES_MORE_SHEET) return "more";
  const active = bandActiveId(place);
  return active && BAND_KEYS.has(active)
    ? (active as NotesBandDestinationKey)
    : "more";
}

export interface NotesMoreRow {
  shelf: ShelfId;
  label: string;
  meta?: string;
  icon: string;
}

const MORE_ICONS: readonly string[] = [
  "Camera",
  "Music",
  "Tag",
  "Trash",
  "History",
];

/** Rows keyed to SHARED shelf ids: labels stay the web app's words. */
export const NOTES_MORE_ROWS: readonly NotesMoreRow[] = MORE_SHELVES.map(
  (shelf, index) => {
    const caption = captionFor(shelf);
    return {
      shelf,
      label: shelfCopy(shelf).title,
      icon: MORE_ICONS[index] ?? "more-vertical",
      ...(caption ? { meta: caption } : {}),
    };
  }
);
