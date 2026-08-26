import type { SearchStatus } from "../_shared/search-scaffold.ts";
import type { DriveFilters } from "./filters.ts";
// Type-only — no runtime members — so every importer uses `import type`, which
// esbuild strips at serve time; a value import of this module would 404. The
// shapes are grounded in the query payloads: `DriveDoc` is one shape row-for-row
// across browse and search, `Folder` a folders-scheme concept as a nav row.
import type { KIND_ICONS } from "./icons.ts";
import type { ShelfId } from "./shelves.ts";

/** One person a share reaches. */
export interface SharedMember {
  party_id: string;
  label: string;
  capability: "read" | "read+write";
  /** `invited` until their vault accepts; a refuser is absent entirely. */
  status: "invited" | "current";
}

/** A commons grant over the document itself or a folder above it (#821). */
export interface SharedWith {
  grant_id: string;
  circle_id: string;
  /** The circle's name, or the recipients' for an implicit circle. */
  label: string;
  via: "document" | "folder";
  /** The folder the rail names under `via: "folder"`, else the document. */
  container_id: string;
  members: SharedMember[];
  member_count: number;
  pending_count: number;
}

/** One free-form label (core.tag_item over the shared Tags scheme). */
export interface DocTag {
  tag_id: string;
  label: string;
}

/**
 * `document_id` is identity — selection, details, quick-look and folders/star
 * all key off it; `content_id` names the HEAD revision whose bytes render.
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
  /** Present only on a `search` result row. */
  snippet?: string;
  tags: DocTag[];
  custody_state: string | null;
  /**
   * `[]` is "shared with nobody"; `null` is "the share reads were denied", which
   * both readers treat as UNKNOWN — absent, not negative, so nothing on screen
   * says "not shared" (#821).
   */
  shared_with: SharedWith[] | null;
}

/**
 * One key per sortable column: the head IS the sort control, so a key with no
 * column is an order nobody can see or reverse. `changed`, not `added` — and
 * nothing in the product records when a document was OPENED.
 */
export type SortKey = "changed" | "kind" | "name" | "owner" | "size";

/** A key AND a direction: "Date changed" is two orders, and a member picking
 *  from a list is picking one of them, not a column to press twice. */
export interface SortOption {
  key: SortKey;
  dir: 1 | -1;
  /** e.g. "Date changed". */
  name: string;
  /** e.g. "newest first". */
  sub: string;
}

/**
 * FOUR STATES, NOT A PERCENTAGE: this transport stages a whole file then commits
 * it, so the only truthful readings are not-started, in-flight, landed and
 * did-not-land. A bar creeping to 62% on a number nobody measured is worse.
 */
export interface UploadItem {
  name: string;
  state: "waiting" | "running" | "landed" | "parked" | "failed";
  /** In the member's words. Only on `failed`. */
  reason?: string;
}

/** A folders-scheme SKOS concept, projected as a nav row. */
export interface Folder {
  folder_id: string;
  name: string;
  parent_id: string | null;
}

/** One entry in a document's version chain. */
export interface VersionEntry {
  content_id: string;
  media_type: string | null;
  byte_size: number | null;
  content_uri?: string;
  poster_uri: string | null;
  current: boolean;
  asserted_at: string;
}

/** One provenance event in a document's activity trail. */
export interface ActivityEvent {
  activity: string;
  agent_kind: string;
  occurred_at: string;
}

/** The minimal projection the pure format helpers read. */
export interface DocFields {
  media_type?: string | null;
  content_uri?: string | null;
  title?: string | null;
}

/** Custody in owner-facing words + the CSS tone it keys. */
export type CustodyTone = "ok" | "warn" | "danger";
export interface CustodyInfo {
  label: string;
  tone: CustodyTone;
}

/** What a media_type maps to: label, name, filter cat, tint var. */
export interface TypeMeta {
  label: string;
  name: string;
  cat: string;
  cv: string;
  /** Derived from `cat` where `cat` is decided, so a new kind cannot arrive
   *  with a colour and a word but no shape. */
  glyph: keyof typeof KIND_ICONS;
}

/** Mutated in place, NEVER reassigned: logic.ts/nav.ts close over this object. */
export interface AppData {
  folders: Folder[];
  documents: DriveDoc[];
  root_folder_id: string | null;
}

/** Mutated in place, NEVER reassigned: logic.ts/nav.ts close over it at boot. */
export interface AppState {
  view: "grid" | "list";
  /**
   * ONE id (`null` for All, `folder:<id>` for a folder), never a flat NavKind
   * enum: five surfaces read it, and one value is what stops them disagreeing
   * about where the member is. Nothing persists it.
   */
  shelf: ShelfId;
  /**
   * One per axis (§4.2). Separate from the older `type`/`tag` chips: the four
   * axes COMPOSE, and §4.6's "a filter with no matches" is only answerable if
   * "is anything set" has one home (`filtersActive`).
   */
  filters: DriveFilters;
  sortKey: SortKey;
  sortDir: 1 | -1;
  /**
   * SELECTION IS A MODE (§4.1): a checkbox on every row forever occupies the
   * leading edge of the thing the member came to read. Leaving the mode clears
   * `selected` — a selection nobody can see surprises the next command.
   */
  selecting: boolean;
  /**
   * A clean queue clears itself; one with failures STAYS until dismissed,
   * because "three did not land" is the sentence a disappearing toast loses.
   */
  uploadQueue: UploadItem[];
  tag: string;
  search: string;
  searchResults: DriveDoc[] | null;
  /**
   * READ, never inferred: a failed reach and an empty result set are different
   * sentences, and search will not pretend to have looked. `applySearch` sets
   * this from what the read actually did.
   */
  searchStatus: SearchStatus;
  searchSeq: number;
  selected: Set<string>;
  anchorIndex: number | null;
  detailsId: string | null;
  /** The one viewer, for every kind (§7). */
  quickId: string | null;
  /** Open as its own route (§6.2). */
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
