// NOTES' SEAT COPY (#1015, S11). Every string a Notes screen says used to be
// spelled where it was rendered: the place → empty-state chain in
// `NotesHome.tsx`, the editor's own title in `NoteEditor.tsx`, the two
// failure titles beside their `catch`. A label spelled at the point of use is
// a label no sweep can see, and Notes had no table for one to sweep.
//
// The BLUEPRINT owns the copy every seat shares
// (`@centraid/blueprints/apps/notes/view-copy`). This module owns the copy
// this seat alone says, and nothing else may spell one inline.

import {
  DELETE_NOTE_BODY,
  EMPTY_DAY_ONE,
  HISTORY_NEEDS_NOTE,
  JOURNAL_ROW,
} from "@centraid/blueprints/apps/notes/view-copy";

export interface NotesEmptyCopy {
  title: string;
  body: string;
}

/**
 * The empty state of each place that has one of its own. `null` is the
 * library, and every place without an entry falls back to `NOTES_EMPTY_REST`
 * — a shelf with nothing on it says the same thing wherever it is.
 */
export const NOTES_EMPTY: Readonly<Record<string, NotesEmptyCopy>> = {
  history: {
    body: "Open a note to walk its chain.",
    title: HISTORY_NEEDS_NOTE,
  },
  journal: { body: JOURNAL_ROW, title: "No journal entries yet" },
  trash: { body: DELETE_NOTE_BODY, title: "Trash is empty" },
};

export const NOTES_EMPTY_REST: NotesEmptyCopy = {
  body: EMPTY_DAY_ONE,
  title: "Nothing written yet",
};

/**
 * What the editor calls itself. Three states, one table: a note being read, a
 * note in the trash, and a note that does not exist yet.
 */
export const NOTES_EDITOR_TITLE = {
  fresh: "New note",
  note: "Note",
  trashed: "In trash",
} as const;

export function editorTitle(note?: { trashed?: boolean }): string {
  if (!note) return NOTES_EDITOR_TITLE.fresh;
  return note.trashed ? NOTES_EDITOR_TITLE.trashed : NOTES_EDITOR_TITLE.note;
}

/**
 * S14: an outcome names what it happened to. "Not applied" and "Action
 * failed" named nothing a member owns, and the second one carried the
 * exception's own message behind it.
 */
export const NOTES_WRITE_REFUSED = "Note change not applied";
export const NOTES_WRITE_FAILED = "Note change not saved";
/** The pin/unpin verb pair, so neither word is spelled at a call site. */
export const NOTES_PIN = { off: "Pin", on: "Unpin" } as const;

/**
 * What each list IS, for the rotor. `SeatList` requires a name, and Notes was
 * handing it the caption the screen already draws underneath — so VoiceOver
 * said the rail's whole explanatory sentence where it needed two words, and
 * the member heard the same sentence twice. A list is named, never captioned.
 */
export const NOTES_LIST_NAMES = {
  notebooks: "Notebooks",
  tags: "Tags",
  trash: "Notes in trash",
} as const;
