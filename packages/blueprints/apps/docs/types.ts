// Shared page-side shapes for the docs app (TS conversion). Type-only — no
// runtime members — so every importer uses `import type`, which esbuild strips
// at serve time (a value import of this module would 404). Grounded in the
// query payloads: `DriveDoc` is the decorated document row the `drive`/`search`
// queries return (the drive projection, one shape row-for-row across browse and
// search, `snippet` present only on a search hit); `Folder` is the folders-scheme
// concept projected as a nav row; `VersionEntry`/`ActivityEvent` are what the
// `history`/`activity` reads hand the History/Activity panels.

/** One free-form label on a document (core.tag_item over the shared Tags scheme). */
export interface DocTag {
  tag_id: string;
  label: string;
}

/**
 * A decorated document row — a `core.document` wrapper joined to its current
 * content item (issue #352). `document_id` is identity (selection, details,
 * quick-look, folders/star all key off it); `content_id` names the HEAD
 * revision whose bytes render.
 */
export interface DriveDoc {
  document_id: string;
  content_id: string;
  title: string;
  media_type: string | null;
  byte_size: number | null;
  content_uri?: string;
  poster_uri: string | null;
  created_at: string;
  updated_at: string;
  folder_id: string | null;
  starred: boolean;
  trashed: boolean;
  purge_at: string | null;
  /** The vault's FTS hit snippet — present only on a `search` result row. */
  snippet?: string;
  tags: DocTag[];
  custody_state: string | null;
}

/** A folder — a folders-scheme SKOS concept, projected as a nav row. */
export interface Folder {
  folder_id: string;
  name: string;
  parent_id: string | null;
}

/**
 * The current sidebar navigation selection. `folderId` is optional (present
 * only when `kind === 'folder'`) — kept flat rather than a discriminated union
 * because the sidebar render threads `nav.folderId` down unconditionally, and
 * the JS this ports read it as `undefined` for every non-folder view.
 */
export type NavKind = 'all' | 'recent' | 'starred' | 'folder' | 'trash';
export interface Nav {
  kind: NavKind;
  folderId?: string;
}

/** One entry in a document's version chain (the `history` read). */
export interface VersionEntry {
  content_id: string;
  media_type: string | null;
  byte_size: number | null;
  content_uri?: string;
  poster_uri: string | null;
  current: boolean;
  asserted_at: string;
}

/** One provenance event in a document's activity trail (the `activity` read). */
export interface ActivityEvent {
  activity: string;
  agent_kind: string;
  occurred_at: string;
}

/** The minimal projection the pure media/format helpers read off a doc. */
export interface DocFields {
  media_type?: string | null;
  content_uri?: string | null;
  title?: string | null;
}

/** The blob custody projection in owner-facing words + the CSS tone it keys. */
export type CustodyTone = 'ok' | 'warn' | 'danger';
export interface CustodyInfo {
  label: string;
  tone: CustodyTone;
}

/** The file-type metadata a media_type maps to (label/name/filter cat/tint var). */
export interface TypeMeta {
  label: string;
  name: string;
  cat: string;
  cv: string;
}

/**
 * The module-level `data` bag app.tsx mutates in place (never reassigned) and
 * logic.ts/nav.ts close over. The secret-free document/folder store.
 */
export interface AppData {
  folders: Folder[];
  documents: DriveDoc[];
  root_folder_id: string | null;
}

/**
 * The module-level `state` bag app.tsx mutates in place (never reassigned).
 * logic.ts/nav.ts close over this exact object at boot.
 */
export interface AppState {
  view: 'grid' | 'list';
  nav: Nav;
  sortKey: 'added' | 'name' | 'size';
  sortDir: 1 | -1;
  type: string;
  tag: string;
  search: string;
  searchResults: DriveDoc[] | null;
  searchSeq: number;
  selected: Set<string>;
  anchorIndex: number | null;
  detailsId: string | null;
  quickId: string | null;
  editingId: string | null;
  newMenuOpen: boolean;
  creatingFolder: boolean;
  renamingFolderId: string | null;
  narrow: boolean;
  uploading: boolean;
  visibleRows: DriveDoc[];
  driveWindow: number;
  driveTruncated: boolean;
}

/** The empty-state copy (format.ts's `emptyStateFor`). */
export interface EmptyStateCfg {
  icon: string;
  title: string;
  sub: string;
  needsUpload?: string;
}
