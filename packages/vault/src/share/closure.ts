// The share closure CONTRACT (issue #599 decision 11, split in #726).
//
// A share is two halves that never share a database handle:
//
//   readShareClosure(origin, …)  →  WireClosure  →  projectShareClosure(audience, …)
//     read-only, origin vault       JSON only        one BEGIN IMMEDIATE, audience only
//
// `WireClosure` is what crosses between them. It is plain JSON — no Buffers,
// no handles, no functions — so the same value can be produced in one process
// and consumed in another; P3 puts a tunnel in the middle without either half
// changing. Every table it carries is TEXT/INTEGER/REAL/NULL only, which is
// why a row can be typed as `WireRow`.
//
// STRUCTURAL ONLY. The closure carries rows as they are, and the only edits
// the projection makes are the ones the audience's schema forces: ids that
// collide, and cross-vault foreign keys.
//
// Sharing projects a MINIMAL closure — the item, whatever it structurally
// cannot exist without, and nothing else:
//
//   media.media_asset  →  the asset row + its core_content_item + every
//                         core_content_derivative of that content item
//   core.content_item  →  the content item + its derivatives
//   core.document      →  the document wrapper + current content + derivatives
//
// Two deliberate exclusions:
//
//  1. **Cross-vault FK columns are projected NULL, never carried.** A
//     `creator_party_id` / `origin_device_id` / `place_id` /
//     `camera_device_id` names a row in the ORIGIN vault's graph; that id
//     means nothing in the audience vault (and with `PRAGMA foreign_keys=ON`
//     it would not even insert). Dragging the party/place/device graph across
//     the boundary would also leak the owner's ontology into an audience that
//     was only ever meant to see one photo. Who/where it was attributed to is
//     recorded once, on `core_share_origin.shared_by` — an owner id or a
//     `peer:<vaultId>` string, not a data row.
//
//  2. **No tags, links, collections, annotations or enrichment.** Those are
//     the owner's curation of their own library, not part of the item. What
//     the audience derives for itself it derives through its OWN ingest door
//     (projection-ingest.ts), under its own ontology and its own consent.
//
// Derivatives ARE in the closure: they are what a merged grid actually paints
// (thumb/preview/poster) and what its placeholders come from (thumbhash), and
// re-deriving them in the audience vault would burn CPU to reproduce bytes the
// hardlink gives away for free.
//
// After projection the two rows are INDEPENDENT — divergence by default. A
// caption edited in the origin library does not follow, and nothing here syncs
// it back. `core_share_origin` keeps the lineage so a future re-share/re-sync
// stays possible without one existing now.

/** Item kinds that can be placed into an audience vault at v0. */
export type ShareableItemType =
  | "core.collection"
  | "core.content_item"
  | "core.document"
  | "locker.item"
  | "tally.group"
  | "media.media_asset";

const SHAREABLE_ITEM_TYPES: readonly ShareableItemType[] = [
  "core.collection",
  "core.content_item",
  "core.document",
  "locker.item",
  "tally.group",
  "media.media_asset",
];

/** True for a logical entity name this module knows how to project. */
export function isShareableItemType(value: string): value is ShareableItemType {
  return (SHAREABLE_ITEM_TYPES as readonly string[]).includes(value);
}

/**
 * The wire format's only version. There is no ladder and no COMPAT shim
 * (pre-1.0 hard floor): a closure that does not say `1` is refused, because a
 * half-understood closure would be projected as silent data loss.
 */
export const CLOSURE_FORMAT_VERSION = 1;

/** What a shareable table's column may hold. No BLOB columns cross. */
export type WireValue = string | number | null;

/** A row carried whole, column-for-column, from a table with no fixed shape. */
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

/**
 * Carries `content_id` because derivatives are pooled across every item in the
 * closure — two photographs that share bytes share one content item and one
 * set of derivatives, which is only expressible if each row names its parent.
 */
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
  favorite: number;
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

/** A collection and its entries; every entry's TARGET is a row in `WireRows`. */
export interface WireCollection {
  row: WireRow;
  entries: WireRow[];
}

/** A Tally group's whole ledger. Receipt bytes ride the shared content pool. */
export interface WireTallyGroup {
  group: WireRow;
  circle: WireRow;
  members: WireRow[];
  parties: WireRow[];
  expenses: WireRow[];
  splits: WireRow[];
  settlements: WireRow[];
  recurring: WireRow[];
  exceptions: WireRow[];
  receipts: WireRow[];
  lineItems: WireRow[];
  lineAllocations: WireRow[];
}

/**
 * Row tables, deduped across every item in the closure. A set of photographs
 * that share content (the same bytes re-imported, an album whose cover is also
 * an entry) carries each content item and each derivative exactly ONCE.
 */
export interface WireRows {
  contentItems: ContentItemRow[];
  derivatives: DerivativeRow[];
  mediaAssets: MediaAssetRow[];
  documents: DocumentRow[];
  collections: WireCollection[];
  /**
   * Locker rows arrive still sealed under the ORIGIN vault's DEK, so they can
   * only be projected by a caller holding BOTH keys — the local composition.
   * A locker item is not placeable from any UI (blueprints excludes it), and
   * it cannot cross a tunnel until re-sealing stops needing the origin key.
   */
  lockerItems: WireRow[];
  tallyGroups: WireTallyGroup[];
}

/** One content address the audience vault's CAS must hold. */
export interface BlobManifestEntry {
  sha256: string;
  /**
   * Which rung of the content these bytes are: `"original"`, or the
   * derivative variant carrying them (`thumb`, `preview`, `poster`, …). A
   * transport can move the cheap rungs first without re-reading the origin.
   */
  rung: string;
  /** Byte length as the origin's row records it. */
  size: number;
}

/** One item the closure was asked for, named in ORIGIN ids. */
export interface WireItem {
  itemType: ShareableItemType;
  itemId: string;
}

/** Everything one share of a SET of items reads out of the origin vault. */
export interface WireClosure {
  formatVersion: typeof CLOSURE_FORMAT_VERSION;
  /** Gateway id of the origin vault, recorded as provenance in the audience. */
  originVaultId: string;
  items: WireItem[];
  rows: WireRows;
  blobs: BlobManifestEntry[];
}

/** What one item's projection became in the audience vault. */
export interface ProjectedItem {
  itemType: ShareableItemType;
  /** The item's row id in the ORIGIN vault. */
  originItemId: string;
  /** The projection's row id in the AUDIENCE vault. */
  itemId: string;
  /** True when the audience vault already held this item (idempotent re-share). */
  deduped: boolean;
  /**
   * Audience-side content id when this projection carries bytes. For a media
   * asset, `itemId` is the asset id while `contentId` is the projected
   * `core_content_item` — needed for album covers that FK content, not assets.
   */
  contentId?: string;
}

/** The outcome of projecting one closure into an audience vault. */
export interface ProjectResult {
  /** One entry per `WireClosure.items`, in the same order. */
  items: ProjectedItem[];
}
