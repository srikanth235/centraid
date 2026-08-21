// The shapes the Notes routes read. Every field here is something one of this
// app's own queries (`queries/library.ts`, `note.ts`, `search.ts`,
// `history.ts`, `journal.ts`) actually ships — a view may not invent a fact
// the projection does not carry.
import type { ShelfId } from "./shelves.ts";

/** One tag edge on a note, as the library projection ships it. */
export interface NoteTag {
  tag_id: string;
  concept_id: string;
  label: string;
}

/** A resolved far end of one outbound link, plus the passage it anchored to. */
export interface NoteReference {
  link_id: string;
  selector?: {
    exact?: string;
    prefix?: string;
    suffix?: string;
    start?: number;
  } | null;
  card: {
    type: string;
    id: string;
    title?: string | null;
    subtitle?: string | null;
    status?: string;
  };
}

export interface NoteBacklink {
  link_id: string;
  card: NoteReference["card"];
}

export interface NoteAttachment {
  attachment_id: string;
  content_id: string;
  role?: string;
  media_type?: string;
  title?: string | null;
  content_uri?: string;
  byte_size?: number;
}

/** One row of the library window, the search results, or the Journal place. */
export interface Note extends Record<string, unknown> {
  note_id: string;
  title?: string;
  format?: string;
  pinned?: number;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  purge_at?: string | null;
  /** The short flattened preview (`library`/`search`/`journal`), never a body. */
  preview?: string;
  /** The checklist tally the projection counted, so a card need not parse. */
  check?: { total: number; done: number };
  /** The canonical body, present only once the `note` query has answered. */
  body?: string;
  /** The FTS hit, on a search result row. */
  snippet?: string;
  notebook_ids?: string[];
  notebook_names?: string[];
  attachments?: NoteAttachment[];
  references?: NoteReference[];
  backlinks?: NoteBacklink[];
  tags?: NoteTag[];
}

export interface Notebook {
  notebook_id: string;
  name?: string;
  sort_order?: number;
}

/** One version of a note's body, newest first (`queries/history.ts`). */
export interface NoteVersion {
  content_id: string;
  body: string;
  current: boolean;
  asserted_at: string;
}

/** One powerbox candidate across the seven linkable kinds. */
export interface LinkTarget {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  app: string;
}

/** Everything the library read landed, mutated in place (never reassigned). */
export interface AppData {
  notes: Note[];
  trash: Note[];
  journal: Note[];
  notebooks: Notebook[];
  tags: Array<{ concept_id: string; label: string }>;
  truncated: boolean;
  window: number;
}

/** The one arrangement switch the Library carries (§1's two rows). */
export type LibraryView = "cards" | "list";

export type SearchScope = "everywhere" | "notebook";

/** The mutable bag the orchestrator holds in a ref. */
export interface AppState {
  shelf: ShelfId;
  view: LibraryView;
  /** The open note, for the editor and the version chain. */
  noteId: string | null;
  /** The tag lens over the library — never a place, only a filter. */
  conceptId: string | null;
  search: string;
  searchScope: SearchScope;
  searchResults: Note[] | null;
  searchStatus: "resting" | "searching" | "ready" | "unreachable";
  searchSeq: number;
  /** The `[[` powerbox: the query, its answers, and where the text landed. */
  powerbox: {
    open: boolean;
    term: string;
    targets: LinkTarget[];
    /** The passage the link will anchor to, when one was selected. */
    anchor: { exact: string; prefix: string; suffix: string; start: number };
  };
  /** The version chain for `noteId`, once history has been asked. */
  versions: NoteVersion[] | null;
  libraryWindow: number;
  creatingNotebook: boolean;
  renamingNotebookId: string | null;
  /** How many of this app's writes are still queued on this device. */
  queued: number;
}
