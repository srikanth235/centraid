// Share closure contract (#599 decision 11, #726): readShareClosure(origin) →
// WireClosure → projectShareClosure(audience), sharing no db handle — so
// WireClosure must stay plain JSON (no Buffers, handles, functions).
// STRUCTURAL ONLY: item + content item + derivatives, never tags, links,
// annotations or enrichment; the audience derives its own via
// projection-ingest.ts. Cross-vault FKs (party/device/place/camera) project
// NULL — provenance lives on core_share_origin.shared_by. Projected rows are
// INDEPENDENT; nothing syncs back.

export type ShareableItemType =
  | "core.collection"
  | "core.content_item"
  | "core.document"
  | "docs.folder"
  | "locker.item"
  | "tally.group"
  | "media.asset";

const SHAREABLE_ITEM_TYPES: readonly ShareableItemType[] = [
  "core.collection",
  "core.content_item",
  "core.document",
  "docs.folder",
  "locker.item",
  "tally.group",
  "media.asset",
];

/**
 * The ENTITY a shareable item is. `docs.folder` is Docs' word for a
 * `core.concept`, and `core_share_origin.(target_type, target_id)` is a
 * composite foreign key into the entity supertype (#916), so provenance names
 * the entity rather than the app's word for it.
 */
export function shareOriginEntityType(itemType: ShareableItemType): string {
  return itemType === "docs.folder" ? "core.concept" : itemType;
}

/**
 * The inverse of `shareOriginEntityType`, for the sweeps that read provenance
 * back. In the share plane a projected `core.concept` is a Docs folder: no
 * other kind of concept crosses a vault boundary.
 */
export function shareableItemTypeOfEntity(
  entityType: string
): ShareableItemType | undefined {
  if (entityType === "core.concept") return "docs.folder";
  return isShareableItemType(entityType) ? entityType : undefined;
}

export function isShareableItemType(value: string): value is ShareableItemType {
  return (SHAREABLE_ITEM_TYPES as readonly string[]).includes(value);
}

/** Only accepted version — no ladder, no COMPAT shim; refuse anything else. */
export const CLOSURE_FORMAT_VERSION = 2;

export type WireValue = string | number | null;

export type WireRow = Record<string, WireValue>;

export interface ContentItemRow {
  content_id: string;
  media_type: string;
  content_uri: string;
  sha256: string;
  byte_size: number;
  title: string | null;
  language: string | null;
  deleted_at: string | null;
  purge_at: string | null;
  created_at: string;
}

/** `content_id` is required: derivatives pool across the whole closure. */
export interface DerivativeRow {
  derivative_id: string;
  content_id: string;
  variant: string;
  sha256: string | null;
  media_type: string;
  byte_size: number;
  text_content: string | null;
  created_at: string;
}

export interface MediaAssetRow {
  asset_id: string;
  content_id: string;
  kind: string;
  captured_at: string | null;
  tz_offset_min: number | null;
  capture_group_id: string | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  exif_json: string | null;
  archived_at: string | null;
  deleted_at: string | null;
  purge_at: string | null;
}

export interface DocumentRow {
  document_id: string;
  title: string;
  current_content_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  purge_at: string | null;
}

/** Every entry's TARGET must be a row in `WireRows`. */
export interface WireCollection {
  row: WireRow;
  entries: WireRow[];
}

/** `folders` = concept then descendants; `tags` file docs into them. */
export interface WireDocsFolder {
  scheme: WireRow;
  folders: WireRow[];
  tags: WireRow[];
}

export interface WireTallyGroup {
  group: WireRow;
  circle: WireRow;
  members: WireRow[];
  parties: WireRow[];
  expenses: WireRow[];
  splits: WireRow[];
  payers: WireRow[];
  settlements: WireRow[];
  recurring: WireRow[];
  recurringSplits: WireRow[];
  exceptions: WireRow[];
  receipts: WireRow[];
  lineItems: WireRow[];
  lineAllocations: WireRow[];
}

/** Deduped across the closure: each content item and derivative appears ONCE. */
export interface WireRows {
  contentItems: ContentItemRow[];
  derivatives: DerivativeRow[];
  mediaAssets: MediaAssetRow[];
  documents: DocumentRow[];
  docsFolders: WireDocsFolder[];
  collections: WireCollection[];
  /** Sealed under the ORIGIN DEK: needs both keys, so local-only, never UI-placeable. */
  lockerItems: WireRow[];
  tallyGroups: WireTallyGroup[];
}

export interface BlobManifestEntry {
  sha256: string;
  rung: string;
  size: number;
}

/** Named in ORIGIN ids. */
export interface WireItem {
  itemType: ShareableItemType;
  itemId: string;
}

export interface WireClosure {
  formatVersion: typeof CLOSURE_FORMAT_VERSION;
  originVaultId: string;
  items: WireItem[];
  rows: WireRows;
  blobs: BlobManifestEntry[];
}

export interface ProjectedItem {
  itemType: ShareableItemType;
  /** ORIGIN vault row id. */
  originItemId: string;
  /** AUDIENCE vault row id. */
  itemId: string;
  /** Audience already held it (idempotent re-share). */
  deduped: boolean;
  /** Audience-side content id; for media assets `itemId` is the asset, so covers FK this. */
  contentId?: string;
}

export interface ProjectResult {
  /** One entry per `WireClosure.items`, in the same order. */
  items: ProjectedItem[];
  /**
   * EVERY row the projection resolved, named items included. A share's lineage
   * is keyed by the shape, and `core_share_origin` is keyed by the row and so
   * names one sender only: a second grant over the same photograph stamps
   * nothing and would claim nothing if the caller read provenance back instead
   * of this (#929).
   */
  rows: ProjectedItem[];
}
