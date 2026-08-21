// Every string Notes puts on a screen (Notes spec §6, verbatim).
//
// COPY IS SPECIFIED, NOT PARAPHRASED, so it lives in one table rather than
// inline at fourteen render sites: a sentence written twice is a sentence
// that drifts, and the two destructive confirms plus the consent gate are the
// only reassurance this app is allowed to offer at all.
//
// Multi-sentence strings from the spec's table are stored as their PARTS —
// a title and a body, a fact and its consequence — and joined by the view
// that draws them. That is how the confirms read on screen, and it keeps
// every literal here one sentence long (the copy-density ratchet, #805).
import { countLabel } from "../_shared/app-frame.tsx";
import {
  BOOKS,
  CAPTURE,
  HISTORY,
  JOURNAL,
  NOTE,
  SEARCH,
  TAGS,
  TRASH,
  VOICE,
  notebookIdFrom,
} from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";

/** The two rail heads. The division between a place and a lens is stated in
 *  WORDS, because the paralysis Apple Notes created was a copy problem before
 *  it was a structure problem (§1's third ruling). */
export const RAIL_NOTEBOOKS = "Notebooks · where a note lives";
export const RAIL_TAGS = "Tags · how a note is seen";

/** The two tree rows that are places rather than notebooks. Neither carries
 *  guilt: a pile is a fact the member can look at. */
export const UNFILED_ROW = "Unfiled";
export const UNFILED_NOTE = "a note that was never filed still opens";
export const JOURNAL_ROW = "Journal · written by People · kept apart from the rest";

/** Day one: one sentence, two acts, counts blanked (§4). */
export const EMPTY_DAY_ONE = "Write the first one.";

/** The delete-note confirm — one of the two places the 30-day reassurance is
 *  allowed to be said. */
export const DELETE_NOTE_TITLE = "Move this note to trash?";
export const DELETE_NOTE_BODY =
  "It stays restorable for 30 days, with its links, tags and files.";
export const DELETE_NOTE_VERB = "Trash";

/** The delete-notebook confirm. The notebook's name and its note count are
 *  the vault's own facts, so the sentence is built around them. */
export function deleteNotebookTitle(name: string): string {
  return `Delete “${name}”?`;
}
export function deleteNotebookBody(notes: number): string {
  return `Its ${countLabel(notes, "notes")} become unfiled.`;
}
export const DELETE_NOTEBOOK_KEPT = "Nothing is deleted with it.";
export const DELETE_NOTEBOOK_VERB = "Delete";

/** The vault refuses a duplicate sibling name; the status line surfaces ITS
 *  refusal rather than inventing a second rule in front of it. */
export const RENAME_REFUSAL = "A notebook cannot share a name with its sibling";

export function notebookDeleted(unfiled: number): string {
  return `Notebook deleted · ${unfiled} notes are now unfiled`;
}

export const TRASH_STATUS = "Restorable for 30 days, then erased";

/** The editor's standing status line. The posture of this app is the reopen,
 *  not the save, and the line says so rather than drawing a Save button. */
export function editorStatus(versions: number): string {
  return `Every change is saved as you write · ${versions} versions kept`;
}

export const PENDING_CHIP = "Saved on this device · queued for the vault";

export function pendingStatus(queued: number): string {
  return `${queued} writes queued on this device · they settle when the gateway answers`;
}

/** The conflict panel. Both versions are kept, and there is no filled button
 *  in it — nothing here is the thing the member is supposed to press. */
export const CONFLICT_TITLE = "Two devices changed this passage";
export const CONFLICT_KEPT = "Both are kept.";
export const CONFLICT_INTACT = "Nothing was overwritten.";

export function historyStatus(versions: number): string {
  return `${versions} versions · restoring appends, it never rewrites`;
}

/** A cut list must never read as everything (§4's window-end state). The
 *  counts are grouped by the member's own locale — the tabular/isolate pair
 *  on the element is what keeps them from reordering under RTL. */
export function windowEnd(shown: number, total: number): string {
  const group = new Intl.NumberFormat();
  return `${group.format(shown)} of ${group.format(total)} · this is a window, not the whole library`;
}
export const WINDOW_END_VERB = "Show older";

/** The web seat's replica can lag, and the notice states it rather than
 *  letting the screen imply it is current. */
export function staleReplica(at: string): string {
  return `This replica last matched the vault at ${at}.`;
}
export const STALE_VERB = "Refresh";

export const SEARCH_EMPTY = "Type to search titles and bodies.";
export function searchNoMatch(term: string): string {
  return `Nothing matches “${term}”.`;
}

/** What the results footer says was searched, on this seat. */
export const SEARCH_SCOPE = "the live library";

/** The resting panel's chips are LITERAL queries: a member can type any of
 *  them back and this library will answer. */
export const SEARCH_EXAMPLES: readonly string[] = [
  "roadmap",
  "checklist",
  "anything I wrote in March",
];

/**
 * The four states of the Search route, in the product's own words. The
 * scaffold that renders them (`_shared/SearchScaffold.tsx`) holds no product
 * noun; every sentence below is this app's.
 *
 * A SEARCH THAT COULD NOT RUN NEVER SAYS "NOTHING MATCHES". The unreachable
 * panel exists so a closed door and an empty shelf are two different
 * sentences.
 */
export const SEARCH_COPY = {
  resting: {
    eyebrow: "Nothing typed",
    title: "Search the half-remembered",
    body: SEARCH_EMPTY,
  },
  searching: {
    lead: "Searching titles and bodies.",
    trail: (count: number): string =>
      count === 1 ? "match so far." : "matches so far.",
  },
  miss: {
    eyebrow: "No results",
    title: (query: string): string => searchNoMatch(query),
    body: "Nothing in titles, bodies, notebooks or tags.",
    clear: "Clear the query",
  },
  unreachable: {
    eyebrow: "Cannot reach the gateway",
    title: "The index could not be asked",
    body: "The search index lives on the gateway.",
    facts: [] as ReadonlyArray<{ label: string; value: string }>,
    retry: "Search again",
  },
};

/** The powerbox's foot. Locker is not one of the seven kinds, and the sheet
 *  says why rather than leaving its absence to be noticed. */
export const POWERBOX_FOOT =
  "Locker is not searched · a secret is never a link target";

/** The backlinks block states what it IS — the outbound rows read the other
 *  way — because the reverse query is a [forward] ask, not a drawn lie. */
export const BACKLINKS_NOTE =
  "The reverse query is not built yet · these two are the link rows read forwards";

/** An anchored passage in the target note, and the degraded case. */
export function anchoredFrom(noteTitle: string): string {
  return `anchored passage · linked from ${noteTitle}`;
}
export const ANCHOR_DEGRADED = "the passage was edited · this anchor now points at the note";

/** Capture and voice — the two origin acts (§1). Each names where the
 *  content lands and states its local custody before it syncs. */
export const CAPTURE_SCANNER = "Docs owns the scanner.";
export const CAPTURE_WHAT = "This is a photograph, attached to a note.";
export const CAPTURE_CUSTODY = "On this phone only until the gateway answers";
export const VOICE_NO_TRANSCRIPT_YET = "No transcript yet.";
export const VOICE_AUDIO_READABLE = "The audio is safe and readable as audio.";

/** The consent gate (§4's denied state). It names what is untouched, which
 *  is the fact a denial most often makes a member doubt. */
export const DENIED_TITLE = "Notes cannot read this vault";
export const DENIED_ASK = "Ask the owner of this vault for access.";
export const DENIED_INTACT = "Your notes, versions and receipts are untouched.";

/** The unsupported-by-seat sentence for the two origin acts, on a seat with
 *  no camera or microphone in the member's hand. */
export const ORIGIN_SEAT_ONLY = "This act belongs to the phone.";

export interface ShelfCopy {
  /** The app bar's title on this route. */
  title: string;
  /** The noun the bar's count is pluralised on. */
  unit: string;
}

/** The bar's title and unit per route (§1's screen inventory). */
export function shelfCopy(shelf: ShelfId, notebookName?: string): ShelfCopy {
  if (notebookIdFrom(shelf))
    return { title: notebookName ?? "Notebook", unit: "notes" };
  switch (shelf) {
    case BOOKS:
      return { title: "Notebooks", unit: "notebooks" };
    case JOURNAL:
      return { title: "Journal", unit: "entries" };
    case SEARCH:
      return { title: "Search", unit: "results" };
    case NOTE:
      return { title: "Note", unit: "notes" };
    case HISTORY:
      return { title: "Version history", unit: "versions" };
    case TAGS:
      return { title: "Tags", unit: "tags" };
    case TRASH:
      return { title: "Trash", unit: "notes" };
    case CAPTURE:
      return { title: "Capture", unit: "notes" };
    case VOICE:
      return { title: "Voice", unit: "notes" };
    default:
      return { title: "Notes", unit: "notes" };
  }
}

/** The caption under a route's row set — a fact about the set, never a
 *  reprimand and never a second title. */
export function captionFor(shelf: ShelfId): string | null {
  if (shelf === TRASH) return TRASH_STATUS;
  if (shelf === JOURNAL) return JOURNAL_ROW;
  if (shelf === BOOKS) return RAIL_NOTEBOOKS;
  if (shelf === TAGS) return RAIL_TAGS;
  return null;
}
