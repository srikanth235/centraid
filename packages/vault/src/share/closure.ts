// The projection closure for share-by-placement (issue #599 decision 11).
//
// Sharing projects a MINIMAL closure of rows into the audience vault — the
// item, whatever it structurally cannot exist without, and nothing else:
//
//   media.media_asset  →  the asset row + its core_content_item + every
//                         core_content_derivative of that content item
//   core.content_item  →  the content item + its derivatives
//
// Two deliberate exclusions:
//
//  1. **Cross-vault FK columns are projected NULL, never carried.** A
//     `creator_party_id` / `origin_device_id` / `place_id` /
//     `camera_device_id` names a row in the ORIGIN vault's graph; that id
//     means nothing in the audience vault (and with `PRAGMA foreign_keys=ON`
//     it would not even insert). Dragging the party/place/device graph across
//     the boundary would also leak the owner's ontology into an audience that
//     was only ever meant to see one photo. Who placed it is recorded once, on
//     `core_share_origin.shared_by_member` — a member id, not a data row.
//
//  2. **No tags, links, collections, annotations or enrichment.** Those are
//     the owner's curation of their own library, not part of the item.
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

import type { DatabaseSync } from 'node:sqlite';

import { isBlobUri } from '../blob/store.js';
import { VaultShareError } from '../errors.js';
import { uuidv7 } from '../ids.js';

/** Item kinds that can be placed into an audience vault at v0. */
export type ShareableItemType = 'core.content_item' | 'media.media_asset';

const SHAREABLE_ITEM_TYPES: readonly ShareableItemType[] = [
  'core.content_item',
  'media.media_asset',
];

/** True for a logical entity name this module knows how to project. */
export function isShareableItemType(value: string): value is ShareableItemType {
  return (SHAREABLE_ITEM_TYPES as readonly string[]).includes(value);
}

interface ContentItemRow {
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

interface DerivativeRow {
  derivative_id: string;
  variant: string;
  sha256: string | null;
  media_type: string;
  byte_size: number;
  text_content: string | null;
  created_at: string;
}

interface MediaAssetRow {
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

/** Everything read out of the origin vault for one share, resolved up front. */
export interface ShareClosure {
  itemType: ShareableItemType;
  /** The top-level row's id in the ORIGIN vault. */
  itemId: string;
  contentItem: ContentItemRow;
  derivatives: DerivativeRow[];
  mediaAsset: MediaAssetRow | null;
  /** Content addresses the audience vault's CAS must hold for this closure. */
  shas: string[];
}

const CONTENT_ITEM_COLUMNS = `content_id, media_type, content_uri, sha256, byte_size, title,
       language, deleted_at, purge_at, created_at`;

const DERIVATIVE_COLUMNS = `derivative_id, variant, sha256, media_type, byte_size,
       text_content, created_at`;

const MEDIA_ASSET_COLUMNS = `asset_id, content_id, kind, captured_at, tz_offset_min,
       capture_group_id, width, height, duration_s, exif_json, favorite,
       archived_at, deleted_at, purge_at`;

function readContentItem(db: DatabaseSync, contentId: string): ContentItemRow {
  const row = db
    .prepare(`SELECT ${CONTENT_ITEM_COLUMNS} FROM core_content_item WHERE content_id = ?`)
    .get(contentId) as ContentItemRow | undefined;
  if (!row) throw new VaultShareError(`core.content_item ${contentId} is not in the origin vault`);
  return row;
}

function readDerivatives(db: DatabaseSync, contentId: string): DerivativeRow[] {
  return db
    .prepare(
      `SELECT ${DERIVATIVE_COLUMNS} FROM core_content_derivative
        WHERE content_id = ? ORDER BY variant`,
    )
    .all(contentId) as unknown as DerivativeRow[];
}

/** Content addresses a closure needs resident in the audience CAS. */
function shasOf(contentItem: ContentItemRow, derivatives: DerivativeRow[]): string[] {
  const shas = new Set<string>();
  // An inline body (`data:` uri) is carried in the row itself, so only a
  // blob-backed item rents a CAS entry — the same rule `liveBlobShas` applies.
  if (isBlobUri(contentItem.content_uri)) shas.add(contentItem.sha256);
  for (const derivative of derivatives) {
    // Binary variants live in the CAS; semantic ones are inline text.
    if (derivative.sha256 !== null) shas.add(derivative.sha256);
  }
  return [...shas];
}

/** Resolve everything one share needs from the origin vault. Read-only. */
export function readShareClosure(
  origin: DatabaseSync,
  itemType: ShareableItemType,
  itemId: string,
): ShareClosure {
  if (itemType === 'core.content_item') {
    const contentItem = readContentItem(origin, itemId);
    const derivatives = readDerivatives(origin, contentItem.content_id);
    return {
      itemType,
      itemId,
      contentItem,
      derivatives,
      mediaAsset: null,
      shas: shasOf(contentItem, derivatives),
    };
  }
  const asset = origin
    .prepare(`SELECT ${MEDIA_ASSET_COLUMNS} FROM media_media_asset WHERE asset_id = ?`)
    .get(itemId) as MediaAssetRow | undefined;
  if (!asset) throw new VaultShareError(`media.media_asset ${itemId} is not in the origin vault`);
  const contentItem = readContentItem(origin, asset.content_id);
  const derivatives = readDerivatives(origin, contentItem.content_id);
  return {
    itemType,
    itemId,
    contentItem,
    derivatives,
    mediaAsset: asset,
    shas: shasOf(contentItem, derivatives),
  };
}

/**
 * Projected rows REUSE the origin's uuidv7 (ids are globally unique, which
 * makes provenance trivial to read). The only escape is a genuine collision —
 * the audience already holds a different row under that id — where a fresh id
 * is minted rather than corrupting either row.
 */
function freeId(db: DatabaseSync, table: string, column: string, preferred: string): string {
  const taken = db
    .prepare(`SELECT 1 AS present FROM "${table}" WHERE "${column}" = ?`)
    .get(preferred);
  return taken ? uuidv7() : preferred;
}

/** The outcome of projecting one closure into an audience vault. */
export interface ProjectionResult {
  /** The top-level row's id in the AUDIENCE vault. */
  itemId: string;
  /** True when the audience vault already held this item (idempotent re-share). */
  deduped: boolean;
}

function projectContentItem(audience: DatabaseSync, row: ContentItemRow): string {
  // `core_content_item.sha256` is UNIQUE, so re-sharing the same bytes — even
  // by a different member — dedupes onto the existing row by construction.
  const existing = audience
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(row.sha256) as { content_id: string } | undefined;
  if (existing) return existing.content_id;
  const contentId = freeId(audience, 'core_content_item', 'content_id', row.content_id);
  audience
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language,
          creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(
      contentId,
      row.media_type,
      row.content_uri,
      row.sha256,
      row.byte_size,
      row.title,
      row.language,
      row.deleted_at,
      row.purge_at,
      row.created_at,
    );
  return contentId;
}

function projectDerivatives(
  audience: DatabaseSync,
  contentId: string,
  rows: DerivativeRow[],
): void {
  const held = audience.prepare(
    'SELECT 1 AS present FROM core_content_derivative WHERE content_id = ? AND variant = ?',
  );
  const insert = audience.prepare(
    `INSERT INTO core_content_derivative
       (derivative_id, content_id, variant, sha256, media_type, byte_size, text_content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    // `UNIQUE (content_id, variant)` is the slot — one thumb per content item.
    if (held.get(contentId, row.variant)) continue;
    insert.run(
      freeId(audience, 'core_content_derivative', 'derivative_id', row.derivative_id),
      contentId,
      row.variant,
      row.sha256,
      row.media_type,
      row.byte_size,
      row.text_content,
      row.created_at,
    );
  }
}

function projectMediaAsset(
  audience: DatabaseSync,
  contentId: string,
  row: MediaAssetRow,
): ProjectionResult {
  // `media_media_asset.content_id` is UNIQUE: one asset per content item, so
  // the dedup falls out of the schema exactly like the content item's sha.
  const existing = audience
    .prepare('SELECT asset_id FROM media_media_asset WHERE content_id = ?')
    .get(contentId) as { asset_id: string } | undefined;
  if (existing) return { itemId: existing.asset_id, deduped: true };
  const assetId = freeId(audience, 'media_media_asset', 'asset_id', row.asset_id);
  audience
    .prepare(
      `INSERT INTO media_media_asset
         (asset_id, content_id, kind, captured_at, tz_offset_min, capture_group_id,
          place_id, camera_device_id, width, height, duration_s, exif_json,
          favorite, archived_at, deleted_at, purge_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      assetId,
      contentId,
      row.kind,
      row.captured_at,
      row.tz_offset_min,
      row.capture_group_id,
      row.width,
      row.height,
      row.duration_s,
      row.exif_json,
      row.favorite,
      row.archived_at,
      row.deleted_at,
      row.purge_at,
    );
  return { itemId: assetId, deduped: false };
}

/**
 * Write the closure into the audience vault. The caller owns the transaction —
 * this is the body of the ONE single-DB transaction a share performs, and the
 * origin vault is never written.
 */
export function projectShareClosure(
  audience: DatabaseSync,
  closure: ShareClosure,
): ProjectionResult {
  const heldContent = audience
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(closure.contentItem.sha256) as { content_id: string } | undefined;
  const contentId = projectContentItem(audience, closure.contentItem);
  projectDerivatives(audience, contentId, closure.derivatives);
  if (closure.mediaAsset === null) {
    return { itemId: contentId, deduped: heldContent !== undefined };
  }
  return projectMediaAsset(audience, contentId, closure.mediaAsset);
}
