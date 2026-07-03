// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); media owns the whole library loop (8 commands with their contracts), so it is large by design.
// Media domain commands (§08): the command pack the Photos projection was
// parked on. An asset is meaning over bytes — media_media_asset decorates a
// canonical core_content_item (sha256-deduped data: URI, same custody as
// attachments) with capture time and dimensions; albums are owner-curated
// orderings over assets. Deleting an asset removes the meaning rows and
// soft-deletes the bytes only when nothing else (an attachment, a note body,
// an avatar) still rents them — content items are canonical and shared, so
// the last reference decides, not the first delete.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { sha256Hex } from '../ids.js';

/** ~8 MB of decoded content; the data: URI is ~4/3 of that in base64. */
const MAX_DATA_URI_CHARS = 11_000_000;

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

/** Pull the media type and decoded size out of a `data:` URI. */
function parseDataUri(uri: string): { mediaType: string; byteSize: number } {
  if (!uri.startsWith('data:')) throw new Error('media must arrive as a data: URI');
  const comma = uri.indexOf(',');
  if (comma === -1) throw new Error('malformed data: URI (no comma)');
  const meta = uri.slice(5, comma);
  const payload = uri.slice(comma + 1);
  const isBase64 = meta.split(';').includes('base64');
  const mediaType = meta.split(';')[0] || 'application/octet-stream';
  const byteSize = isBase64
    ? Buffer.from(payload, 'base64').length
    : Buffer.byteLength(decodeURIComponent(payload), 'utf8');
  return { mediaType, byteSize };
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
const CONTENT_REFERENCES: { table: string; column: string }[] = [
  { table: 'core_attachment', column: 'content_id' },
  { table: 'core_party', column: 'avatar_content_id' },
  { table: 'knowledge_note', column: 'body_content_id' },
  { table: 'social_message', column: 'body_content_id' },
  { table: 'business_invoice', column: 'pdf_content_id' },
  { table: 'home_warranty', column: 'terms_content_id' },
  { table: 'home_maintenance_plan', column: 'instructions_content_id' },
  { table: 'media_media_asset', column: 'content_id' },
];

/** True when no canonical row still points at this content item. */
export function contentUnreferenced(ctx: HandlerCtx, contentId: string): boolean {
  for (const ref of CONTENT_REFERENCES) {
    const row = ctx.db
      .prepare(`SELECT count(*) AS n FROM ${ref.table} WHERE ${ref.column} = ?`)
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
    required: ['data_uri'],
    additionalProperties: false,
    properties: {
      data_uri: { type: 'string', minLength: 6 },
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
      name: 'is_data_uri',
      sql: "SELECT (:data_uri LIKE 'data:%') AS n",
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'within_size_cap',
      sql: `SELECT (length(:data_uri) <= ${MAX_DATA_URI_CHARS}) AS n`,
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
    data_uri: string;
    kind?: string;
    captured_at?: string;
    title?: string;
    width?: number;
    height?: number;
    duration_s?: number;
  };
  const parsed = parseDataUri(input.data_uri);
  const sha = sha256Hex(input.data_uri);
  let contentId: string;
  const existing = ctx.db
    .prepare('SELECT content_id, deleted_at FROM core_content_item WHERE sha256 = ?')
    .get(sha) as { content_id: string; deleted_at: string | null } | undefined;
  if (existing) {
    contentId = existing.content_id;
    if (existing.deleted_at !== null) {
      // Re-uploading trashed bytes restores them — dedup identity survives.
      ctx.db
        .prepare(
          'UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL WHERE content_id = ?',
        )
        .run(contentId);
      ctx.wrote('core.content_item', contentId);
    }
  } else {
    contentId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_content_item
           (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
      )
      .run(
        contentId,
        parsed.mediaType,
        input.data_uri,
        sha,
        parsed.byteSize,
        input.title ?? null,
        ctx.identity.partyId,
        ctx.now,
      );
    ctx.wrote('core.content_item', contentId);
  }
  // media_media_asset.content_id is UNIQUE — the same bytes are one asset.
  const existingAsset = ctx.db
    .prepare('SELECT asset_id FROM media_media_asset WHERE content_id = ?')
    .get(contentId) as { asset_id: string } | undefined;
  if (existingAsset) {
    return { asset_id: existingAsset.asset_id, content_id: contentId, deduped: 1 };
  }
  const assetId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO media_media_asset (asset_id, content_id, kind, captured_at, place_id, camera_device_id, width, height, duration_s, exif_json)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL)`,
    )
    .run(
      assetId,
      contentId,
      input.kind ?? assetKindFor(parsed.mediaType),
      input.captured_at ?? null,
      input.width ?? null,
      input.height ?? null,
      input.duration_s ?? null,
    );
  ctx.wrote('media.media_asset', assetId);
  ctx.cite({
    claim: `${parsed.mediaType} (${parsed.byteSize} bytes) entered the library`,
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
  const input = ctx.input as { asset_id: string; captured_at?: string; title?: string };
  if (input.captured_at !== undefined) {
    ctx.db
      .prepare('UPDATE media_media_asset SET captured_at = ? WHERE asset_id = ?')
      .run(input.captured_at, input.asset_id);
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
      name: 'asset_exists',
      sql: 'SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'asset_removed',
      sql: 'SELECT count(*) AS n FROM media_media_asset WHERE asset_id = :asset_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: deleteAsset,
};

function deleteAsset(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { asset_id: string };
  const asset = ctx.db
    .prepare('SELECT content_id FROM media_media_asset WHERE asset_id = ?')
    .get(input.asset_id) as { content_id: string } | undefined;
  if (!asset) throw new Error('asset vanished between check and execute');
  // Albums whose cover this was fall back to their next remaining entry.
  const covered = ctx.db
    .prepare('SELECT album_id FROM media_album WHERE cover_asset_id = ?')
    .all(input.asset_id) as { album_id: string }[];
  ctx.db.prepare('DELETE FROM media_album_entry WHERE asset_id = ?').run(input.asset_id);
  for (const album of covered) {
    const next = ctx.db
      .prepare(
        'SELECT asset_id FROM media_album_entry WHERE album_id = ? ORDER BY position LIMIT 1',
      )
      .get(album.album_id) as { asset_id: string } | undefined;
    ctx.db
      .prepare('UPDATE media_album SET cover_asset_id = ? WHERE album_id = ?')
      .run(next?.asset_id ?? null, album.album_id);
    ctx.wrote('media.album', album.album_id);
  }
  ctx.db.prepare('DELETE FROM media_face_region WHERE asset_id = ?').run(input.asset_id);
  ctx.db.prepare('DELETE FROM media_media_asset WHERE asset_id = ?').run(input.asset_id);
  ctx.wrote('media.media_asset', input.asset_id);
  const released = releaseContentIfUnreferenced(ctx, asset.content_id);
  ctx.cite({
    claim: `asset ${input.asset_id} left the library; bytes ${released ? 'soft-deleted' : 'still rented elsewhere'}`,
    entityType: 'media.media_asset',
    entityId: input.asset_id,
  });
  return { asset_id: input.asset_id, content_released: released ? 1 : 0 };
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
      sql: 'SELECT count(*) AS n FROM media_album WHERE album_id = :album_id',
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
      `INSERT INTO media_album (album_id, owner_party_id, title, cover_asset_id, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    )
    .run(albumId, actorPartyId(ctx), input.title, ctx.now);
  ctx.wrote('media.album', albumId);
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
      sql: 'SELECT count(*) AS n FROM media_album WHERE album_id = :album_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'title_applied',
      sql: 'SELECT count(*) AS n FROM media_album WHERE album_id = :album_id AND title = :title',
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
    .prepare('UPDATE media_album SET title = ? WHERE album_id = ?')
    .run(input.title, input.album_id);
  ctx.wrote('media.album', input.album_id);
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
      sql: 'SELECT count(*) AS n FROM media_album WHERE album_id = :album_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // The curation is gone; the assets it pointed at are untouched.
      name: 'album_removed',
      sql: 'SELECT count(*) AS n FROM media_album WHERE album_id = :album_id',
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
  ctx.db.prepare('DELETE FROM media_album_entry WHERE album_id = ?').run(input.album_id);
  ctx.db.prepare('DELETE FROM media_album WHERE album_id = ?').run(input.album_id);
  ctx.wrote('media.album', input.album_id);
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
      sql: 'SELECT count(*) AS n FROM media_album WHERE album_id = :album_id',
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
      sql: `SELECT count(*) AS n FROM media_album_entry
             WHERE album_id = :album_id AND asset_id = :asset_id`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'entry_created',
      sql: `SELECT count(*) AS n FROM media_album_entry
             WHERE album_id = :album_id AND asset_id = :asset_id`,
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
  const tail = ctx.db
    .prepare('SELECT COALESCE(MAX(position) + 1, 0) AS p FROM media_album_entry WHERE album_id = ?')
    .get(input.album_id) as { p: number };
  const entryId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO media_album_entry (entry_id, album_id, asset_id, position, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(entryId, input.album_id, input.asset_id, tail.p, ctx.now);
  ctx.wrote('media.album_entry', entryId);
  // The first photo into a coverless album becomes its cover.
  ctx.db
    .prepare(
      'UPDATE media_album SET cover_asset_id = ? WHERE album_id = ? AND cover_asset_id IS NULL',
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
      sql: `SELECT count(*) AS n FROM media_album_entry
             WHERE album_id = :album_id AND asset_id = :asset_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'entry_removed',
      sql: `SELECT count(*) AS n FROM media_album_entry
             WHERE album_id = :album_id AND asset_id = :asset_id`,
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
    .prepare('SELECT entry_id FROM media_album_entry WHERE album_id = ? AND asset_id = ?')
    .get(input.album_id, input.asset_id) as { entry_id: string } | undefined;
  if (!entry) throw new Error('album entry vanished between check and execute');
  ctx.db
    .prepare('DELETE FROM media_album_entry WHERE album_id = ? AND asset_id = ?')
    .run(input.album_id, input.asset_id);
  // A cover that just left the album hands off to the next entry.
  const album = ctx.db
    .prepare('SELECT cover_asset_id FROM media_album WHERE album_id = ?')
    .get(input.album_id) as { cover_asset_id: string | null } | undefined;
  if (album?.cover_asset_id === input.asset_id) {
    const next = ctx.db
      .prepare(
        'SELECT asset_id FROM media_album_entry WHERE album_id = ? ORDER BY position LIMIT 1',
      )
      .get(input.album_id) as { asset_id: string } | undefined;
    ctx.db
      .prepare('UPDATE media_album SET cover_asset_id = ? WHERE album_id = ?')
      .run(next?.asset_id ?? null, input.album_id);
  }
  ctx.wrote('media.album_entry', entry.entry_id);
  return { album_id: input.album_id, asset_id: input.asset_id };
}

/** Register the media domain's commands on a gateway. */
export function registerMediaCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_ASSET);
  gateway.registerCommand(UPDATE_ASSET);
  gateway.registerCommand(DELETE_ASSET);
  gateway.registerCommand(CREATE_ALBUM);
  gateway.registerCommand(RENAME_ALBUM);
  gateway.registerCommand(DELETE_ALBUM);
  gateway.registerCommand(ADD_TO_ALBUM);
  gateway.registerCommand(REMOVE_FROM_ALBUM);
}
