// Shared page-side shapes for the notes app (TS conversion). Type-only — no
// runtime members — so every importer uses `import type`, which esbuild strips
// at serve time (a value import of this module would 404). Grounded in the
// `library`/`search`/`note` query payloads and app.tsx's module-level
// `state`/`data` bags. Mirrors the pilot's locker/types.ts model.
import type { Attachment } from './kit.js';

/** One free-form tag edge decorating a note (library projection). */
export interface NoteTag {
  tag_id: string;
  concept_id: string;
  label: string;
}

/**
 * A note list row (the `library`/`search` projections). `preview`/`check`
 * ride every row (issue #404); `body` is the canonical text, absent until the
 * editor lazily pulls it via the `note` query (or an autosave patches it in).
 */
export interface Note {
  note_id: string;
  title?: string;
  format?: string;
  pinned?: number;
  created_at?: string;
  updated_at?: string;
  preview?: string;
  check?: { total: number; done: number };
  notebook_ids?: string[];
  notebook_names?: string[];
  attachments?: Attachment[];
  references?: unknown[];
  tags?: NoteTag[];
  snippet?: string;
  body?: string;
}

/** A notebook (a core.collection projected to the app's row shape). */
export interface Notebook {
  notebook_id: string;
  name?: string;
  sort_order?: number;
}

/** A sidebar tag chip (concept id + label). */
export interface SidebarTag {
  concept_id: string;
  label: string;
}

/** The current sidebar navigation selection. */
export type Nav =
  | { kind: 'all' }
  | { kind: 'pinned' }
  | { kind: 'notebook'; notebookId: string }
  | { kind: 'tag'; conceptId: string };

/** A parked create (no note_id exists yet) rendered as a ghost card. */
export interface PendingCreate {
  key: string;
  title: string;
  notebookId: string | null;
}

/**
 * The module-level `data` bag app.tsx mutates in place (never reassigned) and
 * logic.ts closes over — the last successful library read.
 */
export interface AppData {
  notes: Note[];
  notebooks: Notebook[];
  tags: SidebarTag[];
  window: number;
}

/** The client-side presentation state — never persisted, never sent to the vault. */
export interface AppState {
  nav: Nav;
  view: 'masonry' | 'list';
  search: string;
  searchResults: Note[] | null;
  libraryWindow: number;
  libraryTruncated: boolean;
  editorId: string | null;
  narrow: boolean;
  editingNotebookId: string | null;
  creatingNotebook: boolean;
  pendingNoteIds: Set<string>;
  pendingNotebookIds: Set<string>;
  pendingCreates: PendingCreate[];
  readFailedShown: boolean;
}

/** The partial the editor's autosave sends through `edit-note`. */
export interface NotePatch {
  title?: string;
  body_text?: string;
}

/** Sidebar summary counts (`sidebarCounts`). */
export interface SidebarCounts {
  all: number;
  pinned: number;
  notebooks: number;
  checks: number;
}

/** The closure `createLogic` receives from app.tsx (state/data + the two entry points). */
export interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
  refresh: () => Promise<void>;
}
