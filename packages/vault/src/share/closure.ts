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

export function shareOriginEntityType(itemType: ShareableItemType): string {
  return itemType === "docs.folder" ? "core.concept" : itemType;
}

export function shareableItemTypeOfEntity(
  entityType: string
): ShareableItemType | undefined {
  if (entityType === "core.concept") return "docs.folder";
  return isShareableItemType(entityType) ? entityType : undefined;
}

export function isShareableItemType(value: string): value is ShareableItemType {
  return (SHAREABLE_ITEM_TYPES as readonly string[]).includes(value);
}

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

export interface WireCollection {
  row: WireRow;
  entries: WireRow[];
}

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

export interface WireRows {
  contentItems: ContentItemRow[];
  derivatives: DerivativeRow[];
  mediaAssets: MediaAssetRow[];
  documents: DocumentRow[];
  docsFolders: WireDocsFolder[];
  collections: WireCollection[];
  lockerItems: WireRow[];
  tallyGroups: WireTallyGroup[];
}

export interface BlobManifestEntry {
  sha256: string;
  rung: string;
  size: number;
}

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
  originItemId: string;
  itemId: string;
  deduped: boolean;
  contentId?: string;
}

export interface ProjectResult {
  items: ProjectedItem[];
}
