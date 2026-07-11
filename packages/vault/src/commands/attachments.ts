// Attachments (core §01): the one cross-cutting write every projection wants
// — pin a file (image, PDF, any media) to a canonical row. An attachment is
// a polymorphic edge (core_attachment.subject_type/subject_id) onto a
// canonical core_content_item.
//
// Byte custody is issue #296: large files arrive STAGED (POST /_vault/blobs
// hashed the bytes into the CAS; `staged_sha` claims them here, which is
// when the receipt mints), small payloads still ride inline as `data_uri`
// (text stays in the row, binaries spill to the CAS), and issue #272's
// `content_id` attaches EXISTING bytes without re-shipping them. Exactly one
// source per call. The edge counts as a reference in the shared GC rule
// (media.ts CONTENT_REFERENCES), so an embedded photo survives the photo
// being trashed in its own app.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { MAX_INLINE_DATA_URI_CHARS, mintContentFromDataUri } from '../blob/mint.js';
import { assertInlineDataUriWithinBudget } from './inline-body-guard.js';

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
  'social.message': 'message_id',
  'health.vital': 'vital_id',
  'finance.recurring_series': 'series_id',
  'business.client': 'client_id',
  'business.project': 'project_id',
  'business.invoice': 'invoice_id',
  'home.asset_item': 'item_id',
  'media.media_asset': 'asset_id',
};

const ROLES = ['photo', 'manual', 'receipt', 'warranty', 'contract', 'embed', 'other'] as const;

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
      /** Small inline bytes. Exactly one of data_uri / content_id / staged_sha. */
      data_uri: { type: 'string', minLength: 6 },
      /** An existing canonical content item — attach without re-uploading. */
      content_id: { type: 'string', minLength: 1 },
      /** Staged bytes (issue #296): claim what POST /_vault/blobs hashed. */
      staged_sha: { type: 'string', minLength: 64, maxLength: 64 },
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
      // Three sources, one per call: staged bytes, inline bytes, or an
      // existing content item (issues #296 / #272).
      name: 'exactly_one_source',
      sql: 'SELECT ((:data_uri IS NOT NULL) + (:content_id IS NOT NULL) + (:staged_sha IS NOT NULL)) AS n',
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
      // The inline door is for SMALL payloads (issue #296): the journal
      // records every input, so big bytes take the staging route.
      name: 'within_size_cap',
      sql: `SELECT CASE WHEN :data_uri IS NULL THEN 1 ELSE (length(:data_uri) <= ${MAX_INLINE_DATA_URI_CHARS}) END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // A staged sha must actually be staged — or already owned (dedup).
      name: 'staged_or_owned',
      sql: `SELECT CASE WHEN :staged_sha IS NULL THEN 1 ELSE
              (EXISTS(SELECT 1 FROM blob_staging WHERE sha256 = :staged_sha AND variant IS NULL)
               OR EXISTS(SELECT 1 FROM core_content_item WHERE sha256 = :staged_sha)) END AS n`,
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
    staged_sha?: string;
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

  // Three sources (issues #272/#296): staged bytes claim their content item
  // (custody's receipt is THIS command's receipt), fresh inline bytes
  // mint-or-dedupe one, and an existing content_id just gains one more edge
  // — no re-upload, and the extra reference keeps the bytes alive through
  // the shared GC rule.
  let contentId: string;
  let mediaType: string;
  let byteSize: number;
  if (input.staged_sha !== undefined) {
    const claimed = ctx.blobs.claimStaged(input.staged_sha, { title: input.title });
    contentId = claimed.contentId;
    mediaType = claimed.mediaType;
    byteSize = claimed.byteSize;
  } else if (input.data_uri !== undefined) {
    // Binary payloads spill to the CAS unconditionally in mintContentFromDataUri;
    // text/* cannot redirect (FTS reads content_uri in-transaction), so it
    // gets the tighter inline budget here (issue #367 §E4).
    assertInlineDataUriWithinBudget(input.data_uri);
    const minted = mintContentFromDataUri(ctx, input.data_uri, { title: input.title });
    contentId = minted.contentId;
    mediaType = minted.mediaType;
    byteSize = minted.byteSize;
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
    throw new Error('attach needs a staged_sha, data_uri or content_id'); // precondition guards this
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
