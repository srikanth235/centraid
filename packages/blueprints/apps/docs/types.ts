import type { SearchStatus } from "../_shared/search-scaffold.ts";
import type { DriveFilters } from "./filters.ts";
// Shared page-side shapes for the docs app (TS conversion). Type-only — no
// runtime members — so every importer uses `import type`, which esbuild strips
// at serve time (a value import of this module would 404). Grounded in the
// query payloads: `DriveDoc` is the decorated document row the `drive`/`search`
// queries return (the drive projection, one shape row-for-row across browse and
// search, `snippet` present only on a search hit); `Folder` is the folders-scheme
// concept projected as a nav row; `VersionEntry`/`ActivityEvent` are what the
// `history`/`activity` reads hand the History/Activity panels.
import type { KIND_ICONS } from "./icons.ts";
import type { ShelfId } from "./shelves.ts";

/** One person a share reaches (queries/_shared.ts `readSharesByDocument`). */
export interface SharedMember {
  party_id: string;
  label: string;
  capability: "read" | "read+write";
  /** `invited` until their own vault accepts. A member who refused is absent. */
  status: "invited" | "current";
}

/**
 * One live share a document sits inside — a commons grant over the document
 * itself or over a folder above it (issue #821).
 */
export interface SharedWith {
  grant_id: string;
  circle_id: string;
  /** The circle's own name, or — for an implicit circle, whose stored name is
   *  a machine string — the recipients' names. */
  label: string;
  via: "document" | "folder";
  /** The granted container: the folder whose name the rail prints under
   *  `via: "folder"`, and the document's own id otherwise. */
  container_id: string;
  members: SharedMember[];
  member_count: number;
  pending_count: number;
}

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
  /**
   * The live shares this document sits inside (issue #821). `[]` is "shared
   * with nobody"; `null` is "the share reads were denied", which the details
   * rail and the People filter axis both treat as UNKNOWN — the fact is absent
   * rather than negative, so nothing on screen says "not shared".
   */
  shared_with: SharedWith[] | null;
}

/**
 * What the drive may be ordered by — one key per sortable column in the row
 * set's head (§4.1), because the head IS the sort control and a key with no
 * column would be an order nobody can see or reverse.
 *
 * `changed`, not `added`: the drive's default is last change, newest first,
 * and Recently changed is a shelf over the same fact. Nothing in the product
 * records when a document was OPENED, so that is not offered.
 */
export type SortKey = "changed" | "kind" | "name" | "owner" | "size";

/**
 * One named order in the sort menu (§4.1's `DSORTS`) — a key AND a direction,
 * because "Date changed" is two orders and a member picking from a list is
 * picking one of them, not a column to press twice.
 */
export interface SortOption {
  key: SortKey;
  dir: 1 | -1;
  /** The property being ordered — "Date changed". */
  name: string;
  /** Which way — "newest first". */
  sub: string;
}

/**
 * One file in the upload queue (§4.4's `bulk`).
 *
 * FOUR STATES, NOT A PERCENTAGE. The handoff draws a determinate bar per file,
 * which is honest where the transport reports bytes sent; this one stages a
 * whole file and then commits it, so the only truthful readings are "not
 * started", "in flight", "landed" and "did not land". A bar creeping to 62% on
 * a number nobody measured is worse than a word that is true.
 */
export interface UploadItem {
  name: string;
  state: "waiting" | "running" | "landed" | "parked" | "failed";
  /** Why it did not land, in the member's words. Only on `failed`. */
  reason?: string;
}

/** A folder — a folders-scheme SKOS concept, projected as a nav row. */
export interface Folder {
  folder_id: string;
  name: string;
  parent_id: string | null;
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
export type CustodyTone = "ok" | "warn" | "danger";
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
  /** Which of `KIND_ICONS` (icons.ts) this kind wears in a row. Derived from
   *  `cat` at the one place `cat` is decided, so a new kind cannot be added
   *  with a colour and a word but no shape. */
  glyph: keyof typeof KIND_ICONS;
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
  view: "grid" | "list";
  /**
   * The current shelf (shelves.ts). This replaced the flat
   * `NavKind = all|recent|starred|folder|trash` bag: a shelf is a value the
   * strip, the band, the app bar, the breadcrumb and the row set all read, so
   * expressing it as one id — with `null` for All and `folder:<id>` for one
   * folder — is what keeps those five surfaces from disagreeing about where
   * the member is. Nothing persists it, so the migration needed no upgrade
   * path.
   */
  shelf: ShelfId;
  /**
   * The filter row's selections (§4.2), one per axis. Separate from the older
   * `type`/`tag` chips because they are a different control with a different
   * rule: the four axes COMPOSE, and §4.6's fourth empty variant is "a filter
   * with no matches", which is only answerable if "is anything set" has one
   * home (`filtersActive`).
   */
  filters: DriveFilters;
  sortKey: SortKey;
  sortDir: 1 | -1;
  /**
   * SELECTION IS A MODE, entered by the app bar's `Select` (§4.1's `showBox`).
   * A checkbox on every row of every drive, forever, is a control the member
   * did not ask for occupying the leading edge of the one thing they came to
   * read. Leaving the mode clears `selected` — a selection nobody can see is a
   * selection that will surprise the next command.
   */
  selecting: boolean;
  /**
   * The upload queue, per file (§4.4's `bulk`). Empty while nothing is in
   * flight and nothing has failed — a queue that has finished cleanly clears
   * itself, and one that has NOT stays on screen until the member dismisses
   * it, because "three did not land" is the sentence a disappearing toast
   * loses.
   */
  uploadQueue: UploadItem[];
  tag: string;
  search: string;
  searchResults: DriveDoc[] | null;
  /**
   * Which of the four honest states the Search shelf is in
   * (`_shared/search-scaffold.ts`). READ, never inferred: a failed reach and
   * an empty result set are different sentences, and collapsing them is
   * exactly what the handoff forbids — "search will not pretend to have
   * looked". `applySearch` sets this from what the read actually did.
   */
  searchStatus: SearchStatus;
  searchSeq: number;
  selected: Set<string>;
  anchorIndex: number | null;
  detailsId: string | null;
  /** The document open on the STAGE (§7) — the one viewer, for every kind:
   *  media on the theater ground, text on paper standing on it. */
  quickId: string | null;
  /** The document whose version history (§6.2) is open, as its own route. */
  versionsId: string | null;
  newMenuOpen: boolean;
  creatingFolder: boolean;
  renamingFolderId: string | null;
  narrow: boolean;
  uploading: boolean;
  visibleRows: DriveDoc[];
  driveWindow: number;
  driveTruncated: boolean;
}
