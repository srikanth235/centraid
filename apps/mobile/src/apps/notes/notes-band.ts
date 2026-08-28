// The phone's bottom band, as Notes claims it: four PLACES plus More — the
// frame's exact cap. Acts sit behind More. Ids, labels and order come from the
// web app's shelf tables, so band, rail and app bar cannot disagree.

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
  label: string;
  icon: string;
}

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

export interface NotesBandCapsule {
  label: "Home";
  icon: "Home";
  size: number;
  edge: "leading";
  /** `false` is the whole reason it is not a sixth tab. */
  inTabGroup: false;
}

export const NOTES_BAND_CAPSULE: NotesBandCapsule = {
  label: "Home",
  icon: "Home",
  size: NOTES_BAND_CAPSULE_SIZE,
  edge: "leading",
  inTabGroup: false,
};

/** Exactly one band exists at any moment. */
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

export const NOTES_MORE_SHEET = "sheet:more";

export type NotesPlace = ShelfId | typeof NOTES_MORE_SHEET;

const BAND_KEYS = new Set(BAND_DESTINATIONS.map((entry) => entry.id));

/** A shelf the band has no room for lights More: that is how the member got
 *  there, and another tab would point at a place they are not looking at. */
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
