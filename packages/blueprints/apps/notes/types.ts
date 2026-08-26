// Shapes the Notes routes read. Every field ships from this app's own queries;
// a view may not invent a fact the projection does not carry.
import type { ShelfId } from "./shelves.ts";

export interface NoteTag {
  tag_id: string;
  concept_id: string;
  label: string;
}

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

export interface Note extends Record<string, unknown> {
  note_id: string;
  title?: string;
  format?: string;
  pinned?: number;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  purge_at?: string | null;
  /** Flattened teaser (`library`/`search`/`journal`) — never a body. The
   *  canonical body arrives only via `note`; `check` is the projection's
   *  tally; `snippet` is the FTS hit on a search row. */
  preview?: string;
  check?: { total: number; done: number };
  body?: string;
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

export interface NoteVersion {
  content_id: string;
  body: string;
  current: boolean;
  asserted_at: string;
}

export interface LinkTarget {
  type: string;
  id: string;
  title: string;
  subtitle?: string;
  app: string;
}

export interface AppData {
  notes: Note[];
  trash: Note[];
  journal: Note[];
  notebooks: Notebook[];
  tags: Array<{ concept_id: string; label: string }>;
  truncated: boolean;
  window: number;
}

export type LibraryView = "cards" | "list";

export type SearchScope = "everywhere" | "notebook";

export interface AppState {
  shelf: ShelfId;
  view: LibraryView;
  noteId: string | null;
  /** Tag lens over the library — never a place, only a filter. */
  conceptId: string | null;
  /** Unfiled is a PLACE in the spine as a library filter — never its own
   *  route; an unfiled note still opens from where it is. */
  unfiledOnly: boolean;
  search: string;
  searchScope: SearchScope;
  /** Notebook Search was scoped FROM; a scope control with no notebook behind
   *  it would be two controls meaning one thing. */
  scopeNotebookId: string | null;
  searchResults: Note[] | null;
  searchStatus: "resting" | "searching" | "ready" | "unreachable";
  searchSeq: number;
  /** The `[[` powerbox: the query, its answers, and where the text landed. */
  powerbox: {
    open: boolean;
    term: string;
    targets: LinkTarget[];
    anchor: { exact: string; prefix: string; suffix: string; start: number };
  };
  versions: NoteVersion[] | null;
  libraryWindow: number;
  creatingNotebook: boolean;
  renamingNotebookId: string | null;
  queued: number;
}
