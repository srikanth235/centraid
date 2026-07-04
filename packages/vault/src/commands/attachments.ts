// Attachments (core §01): the one cross-cutting write every projection wants
// — pin a file (image, PDF, any media) to a canonical row. An attachment is
// a polymorphic edge (core_attachment.subject_type/subject_id) onto a
// canonical core_content_item. Bytes live inline as base64 `data:` URIs,
// sha256-deduped (rent the bytes, own the reference), which is the same
// mechanism note bodies and message bodies already use — extended here to
// arbitrary media, size-capped, because a vault with no blob store shouldn't
// swallow a 4K video into a SQLite row. Large-file custody stays the
// deferred seam; everyday attachments do not need to wait for it.
//
// Issue #272: attach also accepts an EXISTING content item by `content_id`
// (exactly one of data_uri / content_id per call) — "embed these bytes in my
// thing" without shipping them through the caller again. The edge counts as
// a reference in the shared GC rule (media.ts CONTENT_REFERENCES), so an
// embedded photo survives the photo being trashed in its own app.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { sha256Hex } from '../ids.js';

/** ~8 MB of decoded content; the data: URI is ~4/3 of that in base64. */
const MAX_DATA_URI_CHARS = 11_000_000;

/**
 * The entities a projection may attach to, logical name → primary-key column.
 * The physical table is the logical name with the dot underscored
 * (`schedule.task` → `schedule_task`), so only the PK varies. This doubles as
 * an allow-list: an unknown subject_type is refused, never turned into SQL.
 */
const SUBJECT_PK: Record<string, string> = {
  'core.event': 'event_id',
  'core.party': 'party_id',
  'core.transaction': 'txn_id',
  'schedule.task': 'task_id',
  'knowledge.note': 'note_id',
  'social.thread': 'thread_id',
  'health.vital': 'vital_id',
  'finance.recurring_series': 'series_id',
  'business.client': 'client_id',
  'business.project': 'project_id',
  'business.invoice': 'invoice_id',
  'home.asset_item': 'item_id',
  'media.media_asset': 'asset_id',
};

const ROLES = ['photo', 'manual', 'receipt', 'warranty', 'contract', 'embed', 'other'] as const;

interface ParsedDataUri {
  mediaType: string;
  byteSize: number;
}

/** Pull the media type and decoded size out of a `data:` URI. */
function parseDataUri(uri: string): ParsedDataUri {
  if (!uri.startsWith('data:')) throw new Error('attachment must be a data: URI');
  const comma = uri.indexOf(',');
  if (comma === -1) throw new Error('malformed data: URI (no comma)');
  const meta = uri.slice(5, comma); // between "data:" and ","
  const payload = uri.slice(comma + 1);
  const isBase64 = meta.split(';').includes('base64');
  const mediaType = meta.split(';')[0] || 'application/octet-stream';
  const byteSize = isBase64
    ? Buffer.from(payload, 'base64').length
    : Buffer.byteLength(decodeURIComponent(payload), 'utf8');
  return { mediaType, byteSize };
}

/** Dedupe-or-insert the content item behind an attachment. */
function contentItemFor(
  ctx: HandlerCtx,
  uri: string,
  parsed: ParsedDataUri,
  title?: string,
): string {
  const sha = sha256Hex(uri);
  const existing = ctx.db
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(sha) as { content_id: string } | undefined;
  if (existing) return existing.content_id;
  const contentId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      contentId,
      parsed.mediaType,
      uri,
      sha,
      parsed.byteSize,
      title ?? null,
      ctx.identity.partyId,
      ctx.now,
    );
  ctx.wrote('core.content_item', contentId);
  return contentId;
}

const ATTACH: CommandDefinition = {
  name: 'core.attach',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['subject_type', 'subject_id'],
    additionalProperties: false,
    properties: {
      subject_type: { type: 'string', enum: Object.keys(SUBJECT_PK) },
      subject_id: { type: 'string', minLength: 1 },
      /** New bytes, inline. Exactly one of data_uri / content_id (issue #272). */
      data_uri: { type: 'string', minLength: 6 },
      /** An existing canonical content item — attach without re-uploading. */
      content_id: { type: 'string', minLength: 1 },
      /** Only meaningful when minting new bytes; an existing item keeps its title. */
      title: { type: 'string' },
      role: { type: 'string', enum: [...ROLES] },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['attachment_id', 'content_id'],
    properties: {
      attachment_id: { type: 'string' },
      content_id: { type: 'string' },
      is_primary: { type: 'integer' },
    },
  },
  preconditions: [
    {
      // Two sources, one per call: fresh bytes OR an existing content item.
      name: 'exactly_one_source',
      sql: 'SELECT ((:data_uri IS NOT NULL) + (:content_id IS NOT NULL)) AS n',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Inline bytes only: the app read a File as a data: URL client-side.
      name: 'is_data_uri',
      sql: "SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (:data_uri LIKE 'data:%') END AS n",
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Cap the row: a vault with no blob store must not swallow a huge file.
      name: 'within_size_cap',
      sql: `SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (length(:data_uri) <= ${MAX_DATA_URI_CHARS}) END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // An existing item must be live — trashed bytes are not attachable.
      name: 'content_exists',
      sql: `SELECT CASE WHEN :content_id IS NULL THEN 1 ELSE
              (SELECT count(*) FROM core_content_item
                WHERE content_id = :content_id AND deleted_at IS NULL) END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'attachment_links_subject_to_content',
      sql: `SELECT count(*) AS n FROM core_attachment
             WHERE attachment_id = :attachment_id
               AND subject_type = :subject_type AND subject_id = :subject_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: attach,
};

function attach(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    subject_type: string;
    subject_id: string;
    data_uri?: string;
    content_id?: string;
    title?: string;
    role?: string;
  };
  const pk = SUBJECT_PK[input.subject_type];
  if (!pk) throw new Error(`cannot attach to ${input.subject_type}`);
  // The subject must exist. Table and pk both come from the trusted map, so
  // the interpolation is an allow-list lookup, never caller SQL.
  const table = input.subject_type.replace('.', '_');
  const subject = ctx.db
    .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${pk} = ?`)
    .get(input.subject_id) as { n: number };
  if (subject.n !== 1) throw new Error(`no ${input.subject_type} with id ${input.subject_id}`);

  // Two sources (issue #272): fresh bytes mint-or-dedupe a content item;
  // an existing content_id just gains one more edge — no re-upload, and the
  // extra reference keeps the bytes alive through the shared GC rule.
  let contentId: string;
  let mediaType: string;
  let byteSize: number;
  if (input.data_uri !== undefined) {
    const parsed = parseDataUri(input.data_uri);
    contentId = contentItemFor(ctx, input.data_uri, parsed, input.title);
    mediaType = parsed.mediaType;
    byteSize = parsed.byteSize;
  } else if (input.content_id !== undefined) {
    const existing = ctx.db
      .prepare(
        'SELECT media_type, byte_size FROM core_content_item WHERE content_id = ? AND deleted_at IS NULL',
      )
      .get(input.content_id) as { media_type: string; byte_size: number } | undefined;
    if (!existing) throw new Error(`no live content item ${input.content_id}`);
    contentId = input.content_id;
    mediaType = existing.media_type;
    byteSize = existing.byte_size;
  } else {
    throw new Error('attach needs a data_uri or a content_id'); // precondition guards this
  }
  // Role defaults from the media type; images read as photos.
  const role = input.role ?? (mediaType.startsWith('image/') ? 'photo' : 'other');
  // The first file on a subject is its cover; the rest ride along.
  const existing = ctx.db
    .prepare('SELECT count(*) AS n FROM core_attachment WHERE subject_type = ? AND subject_id = ?')
    .get(input.subject_type, input.subject_id) as { n: number };
  const isPrimary = existing.n === 0 ? 1 : 0;
  const attachmentId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_attachment (attachment_id, subject_type, subject_id, content_id, role, is_primary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(attachmentId, input.subject_type, input.subject_id, contentId, role, isPrimary, ctx.now);
  ctx.wrote('core.attachment', attachmentId);
  ctx.cite({
    claim: `${mediaType} (${byteSize} bytes) attached to ${input.subject_type} ${input.subject_id}`,
    entityType: input.subject_type,
    entityId: input.subject_id,
  });
  return { attachment_id: attachmentId, content_id: contentId, is_primary: isPrimary };
}

const DETACH: CommandDefinition = {
  name: 'core.detach',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['attachment_id'],
    additionalProperties: false,
    properties: { attachment_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['attachment_id'],
    properties: { attachment_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'attachment_exists',
      sql: 'SELECT count(*) AS n FROM core_attachment WHERE attachment_id = :attachment_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // The edge is gone. The content item is canonical and deduped — it may
      // back other attachments — so detach never touches it; GC is separate.
      name: 'attachment_removed',
      sql: 'SELECT count(*) AS n FROM core_attachment WHERE attachment_id = :attachment_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: detach,
};

function detach(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { attachment_id: string };
  ctx.db.prepare('DELETE FROM core_attachment WHERE attachment_id = ?').run(input.attachment_id);
  ctx.wrote('core.attachment', input.attachment_id);
  return { attachment_id: input.attachment_id };
}

/** Register the core attachment commands on a gateway. */
export function registerAttachmentCommands(gateway: Gateway): void {
  gateway.registerCommand(ATTACH);
  gateway.registerCommand(DETACH);
}

/** The subject types a projection may attach to — exported for callers/tests. */
export const ATTACHABLE_SUBJECTS = Object.keys(SUBJECT_PK);
