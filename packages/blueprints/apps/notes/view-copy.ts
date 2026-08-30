// Every string Notes puts on a screen (spec §6, verbatim). Copy is specified,
// never paraphrased inline. The two destructive confirms and the consent gate
// are the only reassurance this app may offer. Multi-sentence copy is stored as
// parts and joined by the view, keeping each literal one sentence (#805).
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

export const RAIL_NOTEBOOKS = "Notebooks · where a note lives";
export const RAIL_TAGS = "Tags · how a note is seen";

export const UNFILED_ROW = "Unfiled";
export const UNFILED_NOTE = "a note that was never filed still opens";
export const JOURNAL_ROW =
  "Journal · written by People · kept apart from the rest";

export const EMPTY_DAY_ONE = "Write the first one.";

export const DELETE_NOTE_TITLE = "Move this note to trash?";
export const DELETE_NOTE_BODY =
  "It stays restorable for 30 days, with its links, tags and files.";
export const DELETE_NOTE_VERB = "Trash";

export function deleteNotebookTitle(name: string): string {
  return `Delete “${name}”?`;
}
export function deleteNotebookBody(notes: number): string {
  return `Its ${countLabel(notes, "notes")} become unfiled.`;
}
export const DELETE_NOTEBOOK_KEPT = "Nothing is deleted with it.";
export const DELETE_NOTEBOOK_VERB = "Delete";

/** Surfaces the vault's own refusal; never a second rule in front of it. */
export const RENAME_REFUSAL = "A notebook cannot share a name with its sibling";

export function notebookDeleted(unfiled: number): string {
  return `Notebook deleted · ${unfiled} notes are now unfiled`;
}

export const TRASH_STATUS = "Restorable for 30 days, then erased";

export function editorStatus(versions: number): string {
  return `Every change is saved as you write · ${versions} versions kept`;
}

export const PENDING_CHIP = "Saved on this device · queued for the vault";

export const SEND_TO_TASKS = "Send to Tasks";
export function sentToTasks(title: string): string {
  return `“${title}” is a task now · receipt`;
}

export function pendingStatus(queued: number): string {
  const noun = queued === 1 ? "write" : "writes";
  const pronoun = queued === 1 ? "it settles" : "they settle";
  return `${queued} ${noun} queued on this device · ${pronoun} when the gateway answers`;
}

export const CONFLICT_TITLE = "Two devices changed this passage";
export const CONFLICT_KEPT = "Both are kept.";
export const CONFLICT_INTACT = "Nothing was overwritten.";

export function historyStatus(versions: number): string {
  return `${versions} versions · restoring appends, it never rewrites`;
}

export const HISTORY_UNREADABLE = "The version chain could not be read here.";
export const HISTORY_NEEDS_NOTE = "Open a note to see its versions.";
export const VERSION_TEXT_ELSEWHERE =
  "This version's text is not on this device.";

export function windowEnd(shown: number, total: number): string {
  const group = new Intl.NumberFormat();
  return `${group.format(shown)} of ${group.format(total)} · this is a window, not the whole library`;
}
export const WINDOW_END_VERB = "Show older";

export function staleReplica(at: string): string {
  return `This replica last matched the vault at ${at}.`;
}
export const STALE_VERB = "Refresh";

export const SEARCH_EMPTY = "Type to search titles and bodies.";
export function searchNoMatch(term: string): string {
  return `Nothing matches “${term}”.`;
}

export const SEARCH_SCOPE = "the live library";

/** Literal queries: typing any of these back must answer. */
export const SEARCH_EXAMPLES: readonly string[] = [
  "roadmap",
  "checklist",
  "anything I wrote in March",
];

/** A SEARCH THAT COULD NOT RUN NEVER SAYS "NOTHING MATCHES": a closed door and
 *  an empty shelf are two different sentences. */
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

export const POWERBOX_FOOT =
  "Locker is not searched · a secret is never a link target";

export const BACKLINKS_NOTE =
  "The reverse query is not built yet · these two are the link rows read forwards";

export function anchoredFrom(noteTitle: string): string {
  return `anchored passage · linked from ${noteTitle}`;
}
export const ANCHOR_DEGRADED =
  "the passage was edited · this anchor now points at the note";

export const CAPTURE_SCANNER = "Docs owns the scanner.";
export const CAPTURE_WHAT = "This is a photograph, attached to a note.";
export const CAPTURE_CUSTODY = "On this phone only until the gateway answers";
export const VOICE_NO_TRANSCRIPT_YET = "No transcript yet.";
export const VOICE_AUDIO_READABLE = "The audio is safe and readable as audio.";

export const DENIED_TITLE = "Notes cannot read this vault";
export const DENIED_ASK = "Ask the owner of this vault for access.";
export const DENIED_INTACT = "Your notes, versions and receipts are untouched.";

export const ORIGIN_SEAT_ONLY = "This act belongs to the phone.";

export interface ShelfCopy {
  title: string;
  unit: string;
}

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
    // Named, not swept into `default:` — switch-exhaustiveness-check counts
    // union members, and `default:` does not discharge a named one.
    case null:
      return { title: "Notes", unit: "notes" };
    default:
      return { title: "Notes", unit: "notes" };
  }
}

export function captionFor(shelf: ShelfId): string | null {
  if (shelf === TRASH) return TRASH_STATUS;
  if (shelf === JOURNAL) return JOURNAL_ROW;
  if (shelf === BOOKS) return RAIL_NOTEBOOKS;
  if (shelf === TAGS) return RAIL_TAGS;
  return null;
}
