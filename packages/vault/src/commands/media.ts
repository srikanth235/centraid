// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); media owns the whole library loop (8 commands with their contracts), so it is large by design.
// Media domain commands (§08): the command pack the Photos projection was
// parked on. An asset is meaning over bytes — media_media_asset decorates a
// canonical core_content_item (sha256-deduped data: URI, same custody as
// attachments) with capture time and dimensions; an album is a surface view
// over core_collection, the one owner-curation mechanism (issue #274) — the
// album commands keep their contracts while storage unifies, so a
// collection may also hold documents and notes. Deleting an asset removes
// the meaning rows and
// soft-deletes the bytes only when nothing else (an attachment, a note body,
// an avatar) still rents them — content items are canonical and shared, so
// the last reference decides, not the first delete.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { MAX_INLINE_DATA_URI_CHARS, mintContentFromDataUri } from '../blob/mint.js';
import { setStarred, starredExistsSql } from './flags.js';

/** Soft-deleted bytes linger this long before the lifecycle sweep purges. */
const PURGE_AFTER_DAYS = 30;

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

function assetKindFor(mediaType: string): string {
  if (mediaType.startsWith('video/')) return 'video';
  if (mediaType.startsWith('audio/')) return 'audio';
  if (mediaType.startsWith('image/')) return 'photo';
  return 'scan';
}

function purgeAt(now: string): string {
  return new Date(new Date(now).getTime() + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Every canonical table that can rent a content item besides the media
 * asset itself. The last reference decides whether bytes soft-delete.
 */
const CONTENT_REFERENCES: { table: string; column: string; onlyLive?: string }[] = [
  { table: 'core_attachment', column: 'content_id' },
  { table: 'core_party', column: 'avatar_content_id' },
  { table: 'knowledge_note', column: 'body_content_id' },
  { table: 'social_message', column: 'body_content_id' },
  { table: 'business_invoice', column: 'pdf_content_id' },
  { table: 'home_warranty', column: 'terms_content_id' },
  { table: 'home_maintenance_plan', column: 'instructions_content_id' },
  // A trashed asset is not a rental — it must not keep its bytes alive, or
  // trash could never release anything.
  { table: 'media_media_asset', column: 'content_id', onlyLive: 'deleted_at IS NULL' },
];

/** True when no canonical row still points at this content item. */
export function contentUnreferenced(ctx: HandlerCtx, contentId: string): boolean {
  for (const ref of CONTENT_REFERENCES) {
    const live = ref.onlyLive ? ` AND ${ref.onlyLive}` : '';
    const row = ctx.db
      .prepare(`SELECT count(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?${live}`)
      .get(contentId) as { n: number };
    if (row.n > 0) return false;
  }
  return true;
}

/** Soft-delete a content item's bytes if nothing rents them any more. */
export function releaseContentIfUnreferenced(ctx: HandlerCtx, contentId: string): boolean {
  if (!contentUnreferenced(ctx, contentId)) return false;
  ctx.db
    .prepare('UPDATE core_content_item SET deleted_at = ?, purge_at = ? WHERE content_id = ?')
    .run(ctx.now, purgeAt(ctx.now), contentId);
  ctx.wrote('core.content_item', contentId);
  return true;
}

const ADD_ASSET: CommandDefinition = {
  name: 'media.add_asset',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      /** Small inline bytes. Exactly one of data_uri / staged_sha (#296). */
      data_uri: { type: 'string', minLength: 6 },
      /** Staged bytes: claim what POST /_vault/blobs hashed into the CAS. */
      staged_sha: { type: 'string', minLength: 64, maxLength: 64 },
      kind: { type: 'string', enum: ['photo', 'video', 'audio', 'scan'] },
      captured_at: { type: 'string' },
      title: { type: 'string' },
      width: { type: 'integer', minimum: 1 },
      height: { type: 'integer', minimum: 1 },
      duration_s: { type: 'number', minimum: 0 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['asset_id', 'content_id'],
    properties: {
      asset_id: { type: 'string' },
      content_id: { type: 'string' },
      deduped: { type: 'integer' },
    },
  },
  preconditions: [
    {
      name: 'exactly_one_source',
      sql: 'SELECT ((:data_uri IS NOT NULL) + (:staged_sha IS NOT NULL)) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'is_data_uri',
      sql: "SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (:data_uri LIKE 'data:%') END AS n",
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // The inline door is for SMALL payloads (issue #296): a 4K video takes
      // the staging route, never command JSON (the journal records inputs).
      name: 'within_size_cap',
      sql: `SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (length(:data_uri) <= ${MAX_INLINE_DATA_URI_CHARS}) END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'staged_or_owned',
      sql: `SELECT CASE WHEN :staged_sha IS NULL THEN 1 ELSE
              (EXISTS(SELECT 1 FROM blob_staging WHERE sha256 = :staged_sha AND variant IS NULL)
               OR EXISTS(SELECT 1 FROM core_content_item WHERE sha256 = :staged_sha)) END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'asset_backed_by_content',
      sql: `SELECT count(*) AS n FROM media_media_asset a
             JOIN core_content_item c ON c.content_id = a.content_id
            WHERE a.asset_id = :asset_id AND c.deleted_at IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addAsset,
};

function addAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    data_uri?: string;
    staged_sha?: string;
    kind?: string;
    captured_at?: string;
    title?: string;
    width?: number;
    height?: number;
    duration_s?: number;
  };
  // Staged claims carry spool metadata (issue #296 §4): the gateway sniffed
  // the type and read EXIF server-side, so capture time and dimensions no
  // longer depend on the caller supplying them. Explicit input still wins.
  const spoolMeta = input.staged_sha ? (ctx.blobs.staged(input.staged_sha)?.meta ?? {}) : {};
  const minted = input.staged_sha
    ? ctx.blobs.claimStaged(input.staged_sha, { title: input.title })
    : mintContentFromDataUri(ctx, input.data_uri!, { title: input.title });
  const contentId = minted.contentId;
  // media_media_asset.content_id is UNIQUE — the same bytes are one asset.
  // A trashed asset over these bytes comes back to life: re-upload = restore.
  const existingAsset = ctx.db
    .prepare('SELECT asset_id, deleted_at FROM media_media_asset WHERE content_id = ?')
    .get(contentId) as { asset_id: string; deleted_at: string | null } | undefined;
  if (existingAsset) {
    if (existingAsset.deleted_at !== null) {
      ctx.db
        .prepare(
          'UPDATE media_media_asset SET deleted_at = NULL, purge_at = NULL WHERE asset_id = ?',
        )
        .run(existingAsset.asset_id);
      ctx.wrote('media.media_asset', existingAsset.asset_id);
    }
    return { asset_id: existingAsset.asset_id, content_id: contentId, deduped: 1 };
  }
  const meta = spoolMeta as {
    width?: number;
    height?: number;
    captured_at?: string;
    has_location?: boolean;
    latitude?: number;
    longitude?: number;
  };
  // Spool EXIF (minus the raw text feed) is worth keeping whole — it is the
  // camera's testimony about the bytes, and GPS already passed the
  // media.location policy gate at staging time.
  const exif = Object.fromEntries(
    Object.entries(meta).filter(([k, v]) => k !== 'text' && v !== undefined),
  );
  const assetId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO media_media_asset (asset_id, content_id, kind, captured_at, place_id, camera_device_id, width, height, duration_s, exif_json, deleted_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL)`,
    )
    .run(
      assetId,
      contentId,
      input.kind ?? assetKindFor(minted.mediaType),
      input.captured_at ?? meta.captured_at ?? null,
      input.width ?? meta.width ?? null,
      input.height ?? meta.height ?? null,
      input.duration_s ?? null,
      Object.keys(exif).length > 0 ? JSON.stringify(exif) : null,
    );
  ctx.wrote('media.media_asset', assetId);
  ctx.cite({
    claim: `${minted.mediaType} (${minted.byteSize} bytes) entered the library`,
    entityType: 'media.media_asset',
    entityId: assetId,
  });
  return { asset_id: assetId, content_id: contentId, deduped: 0 };
}

const UPDATE_ASSET: CommandDefinition = {
  name: 'media.update_asset',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['asset_id'],
    additionalProperties: false,
    properties: {
      asset_id: { type: 'string', minLength: 1 },
      captured_at: { type: 'string' },
      // The caption lives on the canonical content item as its title.
      title: { type: 'string' },
      // The contract keeps its `favorite` input; storage is a starred tag on
      // the canonical core.content_item (issue #274) — favorite a photo here
      // and the same content item reads as starred in the drive.
      favorite: { type: 'integer', enum: [0, 1] },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['asset_id'],
    properties: { asset_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'asset_exists',
      sql: 'SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'edits_applied',
      sql: `SELECT (
              (SELECT CASE WHEN :captured_at IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM media_media_asset WHERE asset_id = :asset_id AND captured_at = :captured_at) END)
              AND (SELECT CASE WHEN :title IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM media_media_asset a JOIN core_content_item c ON c.content_id = a.content_id
                                        WHERE a.asset_id = :asset_id AND c.title = :title) END)
              AND (SELECT CASE WHEN :favorite IS NULL THEN 1
                           WHEN :favorite = 1 THEN ${starredExistsSql('core.content_item', '(SELECT content_id FROM media_media_asset WHERE asset_id = :asset_id)')}
                           ELSE NOT ${starredExistsSql('core.content_item', '(SELECT content_id FROM media_media_asset WHERE asset_id = :asset_id)')} END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: updateAsset,
};

function updateAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    asset_id: string;
    captured_at?: string;
    title?: string;
    favorite?: number;
  };
  if (input.captured_at !== undefined) {
    ctx.db
      .prepare('UPDATE media_media_asset SET captured_at = ? WHERE asset_id = ?')
      .run(input.captured_at, input.asset_id);
  }
  if (input.favorite !== undefined) {
    const asset = ctx.db
      .prepare('SELECT content_id FROM media_media_asset WHERE asset_id = ?')
      .get(input.asset_id) as { content_id: string } | undefined;
    if (!asset) throw new Error('asset vanished between check and execute');
    setStarred(ctx, 'core.content_item', asset.content_id, input.favorite === 1);
  }
  if (input.title !== undefined) {
    ctx.db
      .prepare(
        `UPDATE core_content_item SET title = ?
          WHERE content_id = (SELECT content_id FROM media_media_asset WHERE asset_id = ?)`,
      )
      .run(input.title, input.asset_id);
  }
  ctx.wrote('media.media_asset', input.asset_id);
  return { asset_id: input.asset_id };
}

const DELETE_ASSET: CommandDefinition = {
  name: 'media.delete_asset',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['asset_id'],
    additionalProperties: false,
    properties: { asset_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['asset_id'],
    properties: {
      asset_id: { type: 'string' },
      content_released: { type: 'integer' },
    },
  },
  preconditions: [
    {
      // Only a live asset can be trashed — a double-delete fails loudly
      // instead of silently re-stamping the trash date.
      name: 'asset_exists_live',
      sql: `SELECT count(*) AS n FROM media_media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // The standard soft-delete pair (issue #274): the asset carries its
      // own grace window even when its bytes stay rented elsewhere.
      name: 'asset_trashed',
      sql: `SELECT count(*) AS n FROM media_media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NOT NULL AND purge_at IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: deleteAsset,
};

function deleteAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string };
  const asset = ctx.db
    .prepare('SELECT content_id FROM media_media_asset WHERE asset_id = ?')
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error('asset vanished between check and execute');
  // Collections whose cover this was fall back to their next remaining
  // media entry (covers are content ids — the asset's canonical bytes).
  const covered = ctx.db
    .prepare('SELECT collection_id FROM core_collection WHERE cover_content_id = ?')
    .all(asset.content_id) as { collection_id: string }[];
  ctx.db
    .prepare(
      `DELETE FROM core_collection_entry WHERE target_type = 'media.media_asset' AND target_id = ?`,
    )
    .run(input.asset_id);
  for (const collection of covered) {
    ctx.db
      .prepare(
        `UPDATE core_collection SET cover_content_id =
           (SELECT a.content_id FROM core_collection_entry e
              JOIN media_media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.target_type = 'media.media_asset'
             ORDER BY e.position LIMIT 1)
         WHERE collection_id = ?`,
      )
      .run(collection.collection_id, collection.collection_id);
    ctx.wrote('core.collection', collection.collection_id);
  }
  // The asset row itself only trashes — restore_asset (or re-uploading the
  // same bytes) brings it back with its metadata; the lifecycle sweep purges
  // it alongside its content once the purge date passes.
  ctx.db
    .prepare('UPDATE media_media_asset SET deleted_at = ?, purge_at = ? WHERE asset_id = ?')
    .run(ctx.now, purgeAt(ctx.now), input.asset_id);
  ctx.wrote('media.media_asset', input.asset_id);
  const released = releaseContentIfUnreferenced(ctx, asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} moved to trash; bytes ${released ? 'soft-deleted' : 'still rented elsewhere'}`,
    entityType: 'media.media_asset',
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id, content_released: released ? 1 : 0 };
}

const RESTORE_ASSET: CommandDefinition = {
  name: 'media.restore_asset',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['asset_id'],
    additionalProperties: false,
    properties: { asset_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['asset_id'],
    properties: { asset_id: { type: 'string' } },
  },
  preconditions: [
    {
      // Restoring a live asset fails loudly — trash is the only source.
      name: 'asset_is_trashed',
      sql: `SELECT count(*) AS n FROM media_media_asset
             WHERE asset_id = :asset_id AND deleted_at IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'asset_live_with_live_content',
      sql: `SELECT count(*) AS n FROM media_media_asset a
             JOIN core_content_item c ON c.content_id = a.content_id
            WHERE a.asset_id = :asset_id AND a.deleted_at IS NULL AND a.purge_at IS NULL
              AND c.deleted_at IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: restoreAsset,
};

function restoreAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string };
  const asset = ctx.db
    .prepare('SELECT content_id FROM media_media_asset WHERE asset_id = ?')
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error('asset vanished between check and execute');
  ctx.db
    .prepare('UPDATE media_media_asset SET deleted_at = NULL, purge_at = NULL WHERE asset_id = ?')
    .run(input.asset_id);
  ctx.wrote('media.media_asset', input.asset_id);
  // Un-soft-delete the bytes too — same path the re-upload restore takes.
  // Album membership is not restored, matching the benchmark's trash model.
  ctx.db
    .prepare(
      `UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL
        WHERE content_id = ? AND deleted_at IS NOT NULL`,
    )
    .run(asset.content_id);
  ctx.wrote('core.content_item', asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} restored from trash with its bytes`,
    entityType: 'media.media_asset',
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id };
}

const CREATE_ALBUM: CommandDefinition = {
  name: 'media.create_album',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: { title: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['album_id'],
    properties: { album_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'album_created',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: createAlbum,
};

function createAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { title: string };
  const albumId = ctx.newId();
  ctx.db
    .prepare(
      // An album is a top-level collection; sort_order is sibling-scoped
      // (IS, not =, so NULL parents group together).
      `INSERT INTO core_collection (collection_id, owner_party_id, name, cover_content_id, parent_collection_id, sort_order, created_at)
       VALUES (?, ?, ?, NULL, NULL, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM core_collection
                                      WHERE parent_collection_id IS NULL), ?)`,
    )
    .run(albumId, actorPartyId(ctx), input.title, ctx.now);
  ctx.wrote('core.collection', albumId);
  return { album_id: albumId };
}

const RENAME_ALBUM: CommandDefinition = {
  name: 'media.rename_album',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['album_id', 'title'],
    additionalProperties: false,
    properties: {
      album_id: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['album_id'],
    properties: { album_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'album_exists',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'title_applied',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id AND name = :title',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: renameAlbum,
};

function renameAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string; title: string };
  ctx.db
    .prepare('UPDATE core_collection SET name = ? WHERE collection_id = ?')
    .run(input.title, input.album_id);
  ctx.wrote('core.collection', input.album_id);
  return { album_id: input.album_id };
}

const DELETE_ALBUM: CommandDefinition = {
  name: 'media.delete_album',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['album_id'],
    additionalProperties: false,
    properties: { album_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['album_id'],
    properties: { album_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'album_exists',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // The album surface only manages flat collections; a nested one came
      // from the notebook surface and keeps its children until they move.
      name: 'album_has_no_children',
      sql: `SELECT count(*) AS n FROM core_collection
             WHERE parent_collection_id = :album_id`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      // The curation is gone; the members it pointed at are untouched.
      name: 'album_removed',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: deleteAlbum,
};

function deleteAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string };
  ctx.db.prepare('DELETE FROM core_collection_entry WHERE collection_id = ?').run(input.album_id);
  ctx.db.prepare('DELETE FROM core_collection WHERE collection_id = ?').run(input.album_id);
  ctx.wrote('core.collection', input.album_id);
  return { album_id: input.album_id };
}

const ADD_TO_ALBUM: CommandDefinition = {
  name: 'media.add_to_album',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['album_id', 'asset_id'],
    additionalProperties: false,
    properties: {
      album_id: { type: 'string', minLength: 1 },
      asset_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['entry_id'],
    properties: { entry_id: { type: 'string' }, position: { type: 'integer' } },
  },
  preconditions: [
    {
      name: 'album_exists',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :album_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'asset_exists',
      sql: 'SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // A receipted refusal beats a UNIQUE-constraint throw.
      name: 'not_already_in_album',
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'entry_created',
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: addToAlbum,
};

function addToAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string; asset_id: string };
  // Position is one ordered list per collection, across member types.
  const tail = ctx.db
    .prepare(
      'SELECT COALESCE(MAX(position) + 1, 0) AS p FROM core_collection_entry WHERE collection_id = ?',
    )
    .get(input.album_id) as { p: number };
  const entryId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_collection_entry (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'media.media_asset', ?, ?, ?)`,
    )
    .run(entryId, input.album_id, input.asset_id, tail.p, ctx.now);
  ctx.wrote('core.collection_entry', entryId);
  // The first photo into a coverless collection becomes its cover — the
  // cover is the asset's canonical content item.
  ctx.db
    .prepare(
      `UPDATE core_collection SET cover_content_id =
         (SELECT content_id FROM media_media_asset WHERE asset_id = ?)
       WHERE collection_id = ? AND cover_content_id IS NULL`,
    )
    .run(input.asset_id, input.album_id);
  return { entry_id: entryId, position: tail.p };
}

const REMOVE_FROM_ALBUM: CommandDefinition = {
  name: 'media.remove_from_album',
  ownerSchema: 'media',
  inputSchema: {
    type: 'object',
    required: ['album_id', 'asset_id'],
    additionalProperties: false,
    properties: {
      album_id: { type: 'string', minLength: 1 },
      asset_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['album_id', 'asset_id'],
    properties: { album_id: { type: 'string' }, asset_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'entry_exists',
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'entry_removed',
      sql: `SELECT count(*) AS n FROM core_collection_entry
             WHERE collection_id = :album_id AND target_type = 'media.media_asset' AND target_id = :asset_id`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: removeFromAlbum,
};

function removeFromAlbum(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { album_id: string; asset_id: string };
  const entry = ctx.db
    .prepare(
      `SELECT entry_id FROM core_collection_entry
        WHERE collection_id = ? AND target_type = 'media.media_asset' AND target_id = ?`,
    )
    .get(input.album_id, input.asset_id) as { entry_id: string } | undefined;
  if (!entry) throw new Error('album entry vanished between check and execute');
  ctx.db.prepare('DELETE FROM core_collection_entry WHERE entry_id = ?').run(entry.entry_id);
  // A cover that just left the collection hands off to the next media entry.
  const asset = ctx.db
    .prepare('SELECT content_id FROM media_media_asset WHERE asset_id = ?')
    .get(input.asset_id) as { content_id: string } | undefined;
  const collection = ctx.db
    .prepare('SELECT cover_content_id FROM core_collection WHERE collection_id = ?')
    .get(input.album_id) as { cover_content_id: string | null } | undefined;
  if (asset && collection?.cover_content_id === asset.content_id) {
    ctx.db
      .prepare(
        `UPDATE core_collection SET cover_content_id =
           (SELECT a.content_id FROM core_collection_entry e
              JOIN media_media_asset a ON a.asset_id = e.target_id
             WHERE e.collection_id = ? AND e.target_type = 'media.media_asset'
             ORDER BY e.position LIMIT 1)
         WHERE collection_id = ?`,
      )
      .run(input.album_id, input.album_id);
  }
  ctx.wrote('core.collection_entry', entry.entry_id);
  return { album_id: input.album_id, asset_id: input.asset_id };
}

/** Register the media domain's commands on a gateway. */
export function registerMediaCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_ASSET);
  gateway.registerCommand(UPDATE_ASSET);
  gateway.registerCommand(DELETE_ASSET);
  gateway.registerCommand(RESTORE_ASSET);
  gateway.registerCommand(CREATE_ALBUM);
  gateway.registerCommand(RENAME_ALBUM);
  gateway.registerCommand(DELETE_ALBUM);
  gateway.registerCommand(ADD_TO_ALBUM);
  gateway.registerCommand(REMOVE_FROM_ALBUM);
}
