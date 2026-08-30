// Page-side shapes for photos. Type-only: a value import 404s at serve time.
// `Asset`'s index signature keeps unnamed vault columns `unknown`, not `any`.
import type { TripRoutePoint } from "./trips.ts";

export interface AssetTag {
  tag_id: string;
  label: string;
}

export interface Place {
  place_id: string;
  name: string;
  lat?: number | null;
  lng?: number | null;
  kind?: string | null;
  gazetteer?: string | null;
}

export interface Asset {
  asset_id: string;
  /** The scope this row is shown FROM (#599): ids collide, so an unscoped
   *  blob reference paints the WRONG image. */
  scope_id?: string | null;
  content_id?: string | null;
  favorite?: number | boolean | null;
  content_uri?: string | null;
  thumb_uri?: string | null;
  preview_uri?: string | null;
  poster_uri?: string | null;
  byte_size?: number | null;
  bytes?: number | null;
  size_bytes?: number | null;
  media_type?: string | null;
  title?: string | null;
  kind?: string | null;
  taken_at?: string | null;
  captured_at?: string | null;
  /** An absent offset is not an offset of zero. */
  tz_offset_min?: number | null;
  source_asset_id?: string | null;
  created_at?: string | null;
  width?: number | null;
  height?: number | null;
  duration_s?: number | null;
  album_ids?: string[];
  album_titles?: string[];
  place?: Place | null;
  place_id?: string | null;
  tags?: AssetTag[];
  custody_state?: string | null;
  exif_json?: string | Record<string, unknown> | null;
  purge_at?: string | null;
  purge_in_days?: number | null;
  deleted_at?: string | null;
  [key: string]: unknown;
}

export interface Album {
  album_id: string;
  title?: string | null;
  cover_content_id?: string | null;
  count?: number;
  coverUri?: string | null;
}

export interface DuplicateCluster {
  key: string;
  assets: Asset[];
}

export interface MemoryCard {
  key: string;
  title: string;
  sub: string;
  coverUri: string | null;
  coverScopeId?: string | null;
  newestAt: string;
  onOpen: () => void;
  route?: TripRoutePoint[];
}

export interface MemoryRow {
  memory_id: string;
  kind: "on-this-day" | "trip" | "similar";
  title_hint?: string | null;
  day_key?: string | null;
  place_id?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  computed_at?: string | null;
}

export interface MemoryMemberRow {
  memory_id: string;
  asset_id: string;
  ordinal: number;
}

export interface ExifRow {
  label: string;
  value: string;
  // No `href`: a row is a fact, not a departure.
}

export interface ActivityItem {
  text: string;
  date: string;
}

export type { CustodyMeta } from "../_shared/format-kit.ts";

export interface LibraryData {
  assets?: Asset[];
  albums?: Album[];
  places?: Place[];
  trash?: Asset[];
  memories?: MemoryRow[];
  memoryMembers?: MemoryMemberRow[];
  truncated?: boolean;
  tail?: string | null;
  window?: number;
  vaultDenied?: { code?: string; message?: string } | null;
  error?: string;
}
