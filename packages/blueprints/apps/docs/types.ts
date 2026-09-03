import type { SearchStatus } from "../_shared/search-scaffold.ts";
import type { DriveFilters } from "./filters.ts";
import type { KIND_ICONS } from "./icons.ts";
import type { ShelfId } from "./shelves.ts";

export interface SharedMember {
  party_id: string;
  label: string;
  capability: "read" | "read+write";
  status: "invited" | "current";
}

export interface SharedWith {
  grant_id: string;
  circle_id: string;
  label: string;
  via: "document" | "folder";
  container_id: string;
  members: SharedMember[];
  member_count: number;
  pending_count: number;
}

export interface SharedFrom {
  vault_id: string;
  party_id: string | null;
  name: string | null;
  at: number;
}

export interface DocTag {
  tag_id: string;
  label: string;
}

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
  snippet?: string;
  tags: DocTag[];
  custody_state: string | null;
  shared_with: SharedWith[] | null;
  shared_from: SharedFrom | null;
}

export type SortKey = "changed" | "kind" | "name" | "owner" | "size";

export interface SortOption {
  key: SortKey;
  dir: 1 | -1;
  name: string;
  sub: string;
}

export interface UploadItem {
  name: string;
  state: "waiting" | "running" | "landed" | "parked" | "failed";
  reason?: string;
}

export interface Folder {
  folder_id: string;
  name: string;
  parent_id: string | null;
}

export interface VersionEntry {
  content_id: string;
  media_type: string | null;
  byte_size: number | null;
  content_uri?: string;
  poster_uri: string | null;
  current: boolean;
  asserted_at: string;
}

export interface ActivityEvent {
  activity: string;
  agent_kind: string;
  occurred_at: string;
}

export interface DocFields {
  media_type?: string | null;
  content_uri?: string | null;
  title?: string | null;
}

export type { CustodyTone } from "../_shared/format-kit.ts";
export type { CustodyMeta as CustodyInfo } from "../_shared/format-kit.ts";

export interface TypeMeta {
  label: string;
  name: string;
  cat: string;
  cv: string;
  glyph: keyof typeof KIND_ICONS;
}

export interface AppData {
  folders: Folder[];
  documents: DriveDoc[];
  root_folder_id: string | null;
}

export interface AppState {
  view: "grid" | "list";
  shelf: ShelfId;
  filters: DriveFilters;
  sharedFromKnown: boolean;
  sortKey: SortKey;
  sortDir: 1 | -1;
  selecting: boolean;
  uploadQueue: UploadItem[];
  tag: string;
  search: string;
  searchResults: DriveDoc[] | null;
  searchStatus: SearchStatus;
  searchSeq: number;
  selected: Set<string>;
  anchorIndex: number | null;
  detailsId: string | null;
  quickId: string | null;
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
