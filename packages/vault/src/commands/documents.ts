// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); documents own the whole drive loop (8 commands with their contracts), so it is large by design.
// Document commands (core §01): a drive over the vault without a new table.
// A document IS a canonical core_content_item — the same sha256-deduped
// data: URI custody attachments and note bodies use — filed into folders.
// Folders are SKOS concepts in the owner's centraid folders scheme
// (broader_concept_id is the parent), and filing is one core_tag row per
// document: everything the ontology already models, nothing invented. The
// scheme's `root` concept is the drive's top level; every document carries
// exactly one folders-scheme tag, which is also what marks a content item
// as "a document" rather than a note body or message body passing through.
// Trash is the content item's own deleted_at/purge_at lifecycle — restore
// beats regret, and the sweep purges after 30 days.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { sha256Hex } from '../ids.js';

/** ~8 MB of decoded content; the data: URI is ~4/3 of that in base64. */
const MAX_DATA_URI_CHARS = 11_000_000;

/** Soft-deleted bytes linger this long before the lifecycle sweep purges. */
const PURGE_AFTER_DAYS = 30;

// An https URI, not a urn: one — this literal is interpolated into
// condition SQL, where `:folders` would read as a named parameter.
export const FOLDER_SCHEME_URI = 'https://centraid.dev/schemes/folders';

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
  if (!uri.startsWith('data:')) throw new Error('a document must arrive as a data: URI');
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

function purgeAt(now: string): string {
  return new Date(new Date(now).getTime() + PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** The folders scheme, created on first use. */
function folderSchemeId(ctx: HandlerCtx): string {
  const existing = ctx.db
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(FOLDER_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Folders', 'centraid', '1')`,
    )
    .run(schemeId, FOLDER_SCHEME_URI);
  return schemeId;
}

/** The drive's top level — the scheme's `root` concept, created on first use. */
function rootFolderId(ctx: HandlerCtx): string {
  const schemeId = folderSchemeId(ctx);
  const existing = ctx.db
    .prepare(`SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = 'root'`)
    .get(schemeId) as { concept_id: string } | undefined;
  if (existing) return existing.concept_id;
  const conceptId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
       VALUES (?, ?, 'root', 'Documents', NULL, NULL, 'The drive top level')`,
    )
    .run(conceptId, schemeId);
  return conceptId;
}

/** Re-file a document: exactly one folders-scheme tag per content item. */
function fileInto(ctx: HandlerCtx, contentId: string, folderConceptId: string): void {
  ctx.db
    .prepare(
      `DELETE FROM core_tag
        WHERE target_type = 'core.content_item' AND target_id = ?
          AND concept_id IN (SELECT c.concept_id FROM core_concept c
                               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                              WHERE s.uri = ?)`,
    )
    .run(contentId, FOLDER_SCHEME_URI);
  const tagId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
       VALUES (?, 'core.content_item', ?, ?, ?, NULL, ?)`,
    )
    .run(tagId, contentId, folderConceptId, actorPartyId(ctx), ctx.now);
  ctx.wrote('core.tag', tagId);
}

/** Condition fragment: the id is a live document (filed + not trashed). */
const DOCUMENT_EXISTS_SQL = `
  SELECT count(*) AS n FROM core_content_item i
   WHERE i.content_id = :content_id AND i.deleted_at IS NULL
     AND EXISTS(SELECT 1 FROM core_tag t
                  JOIN core_concept c ON c.concept_id = t.concept_id
                  JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                 WHERE t.target_type = 'core.content_item' AND t.target_id = i.content_id
                   AND s.uri = '${FOLDER_SCHEME_URI}')`;

const ADD_DOCUMENT: CommandDefinition = {
  name: 'core.add_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['data_uri', 'title'],
    additionalProperties: false,
    properties: {
      data_uri: { type: 'string', minLength: 6 },
      title: { type: 'string', minLength: 1 },
      folder_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['content_id'],
    properties: {
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
    {
      name: 'folder_exists_if_given',
      sql: `SELECT CASE WHEN :folder_id IS NULL THEN 1
                 ELSE EXISTS(SELECT 1 FROM core_concept c
                               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                              WHERE c.concept_id = :folder_id AND s.uri = '${FOLDER_SCHEME_URI}')
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'document_filed',
      sql: DOCUMENT_EXISTS_SQL,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addDocument,
};

function addDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { data_uri: string; title: string; folder_id?: string };
  const parsed = parseDataUri(input.data_uri);
  const sha = sha256Hex(input.data_uri);
  let contentId: string;
  let deduped = 0;
  const existing = ctx.db
    .prepare('SELECT content_id, deleted_at FROM core_content_item WHERE sha256 = ?')
    .get(sha) as { content_id: string; deleted_at: string | null } | undefined;
  if (existing) {
    contentId = existing.content_id;
    deduped = 1;
    // Re-uploading known bytes restores them from trash and renames them.
    ctx.db
      .prepare(
        'UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL, title = ? WHERE content_id = ?',
      )
      .run(input.title, contentId);
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
        input.title,
        ctx.identity.partyId,
        ctx.now,
      );
  }
  ctx.wrote('core.content_item', contentId);
  fileInto(ctx, contentId, input.folder_id ?? rootFolderId(ctx));
  ctx.cite({
    claim: `"${input.title}" (${parsed.mediaType}, ${parsed.byteSize} bytes) filed into the drive`,
    entityType: 'core.content_item',
    entityId: contentId,
  });
  return { content_id: contentId, deduped };
}

const RENAME_DOCUMENT: CommandDefinition = {
  name: 'core.rename_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['content_id', 'title'],
    additionalProperties: false,
    properties: {
      content_id: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['content_id'],
    properties: { content_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'title_applied',
      sql: 'SELECT count(*) AS n FROM core_content_item WHERE content_id = :content_id AND title = :title',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: renameDocument,
};

function renameDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { content_id: string; title: string };
  ctx.db
    .prepare('UPDATE core_content_item SET title = ? WHERE content_id = ?')
    .run(input.title, input.content_id);
  ctx.wrote('core.content_item', input.content_id);
  return { content_id: input.content_id };
}

const MOVE_DOCUMENT: CommandDefinition = {
  name: 'core.move_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['content_id'],
    additionalProperties: false,
    properties: {
      content_id: { type: 'string', minLength: 1 },
      // Omitted folder_id means back to the drive's top level.
      folder_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['content_id'],
    properties: { content_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
    {
      name: 'folder_exists_if_given',
      sql: `SELECT CASE WHEN :folder_id IS NULL THEN 1
                 ELSE EXISTS(SELECT 1 FROM core_concept c
                               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                              WHERE c.concept_id = :folder_id AND s.uri = '${FOLDER_SCHEME_URI}')
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Filed exactly once — the move replaced, never duplicated.
      name: 'filed_once',
      sql: `SELECT count(*) AS n FROM core_tag t
              JOIN core_concept c ON c.concept_id = t.concept_id
              JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
             WHERE t.target_type = 'core.content_item' AND t.target_id = :content_id
               AND s.uri = '${FOLDER_SCHEME_URI}'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: moveDocument,
};

function moveDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { content_id: string; folder_id?: string };
  fileInto(ctx, input.content_id, input.folder_id ?? rootFolderId(ctx));
  ctx.wrote('core.content_item', input.content_id);
  return { content_id: input.content_id };
}

const TRASH_DOCUMENT: CommandDefinition = {
  name: 'core.trash_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['content_id'],
    additionalProperties: false,
    properties: { content_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['content_id', 'purge_at'],
    properties: { content_id: { type: 'string' }, purge_at: { type: 'string' } },
  },
  preconditions: [
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
    {
      // Bytes still rented by another canonical row (an attachment on a
      // lead, a note body, an avatar) refuse to trash — release those first.
      name: 'not_rented_elsewhere',
      sql: `SELECT (
              EXISTS(SELECT 1 FROM core_attachment WHERE content_id = :content_id)
              OR EXISTS(SELECT 1 FROM core_party WHERE avatar_content_id = :content_id)
              OR EXISTS(SELECT 1 FROM knowledge_note WHERE body_content_id = :content_id)
              OR EXISTS(SELECT 1 FROM social_message WHERE body_content_id = :content_id)
              OR EXISTS(SELECT 1 FROM business_invoice WHERE pdf_content_id = :content_id)
              OR EXISTS(SELECT 1 FROM home_warranty WHERE terms_content_id = :content_id)
              OR EXISTS(SELECT 1 FROM home_maintenance_plan WHERE instructions_content_id = :content_id)
              OR EXISTS(SELECT 1 FROM media_media_asset WHERE content_id = :content_id)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'document_trashed',
      sql: `SELECT count(*) AS n FROM core_content_item
             WHERE content_id = :content_id AND deleted_at IS NOT NULL AND purge_at IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: trashDocument,
};

function trashDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { content_id: string };
  const until = purgeAt(ctx.now);
  ctx.db
    .prepare('UPDATE core_content_item SET deleted_at = ?, purge_at = ? WHERE content_id = ?')
    .run(ctx.now, until, input.content_id);
  ctx.wrote('core.content_item', input.content_id);
  ctx.cite({
    claim: `document ${input.content_id} moved to trash; purges after ${until.slice(0, 10)}`,
    entityType: 'core.content_item',
    entityId: input.content_id,
  });
  return { content_id: input.content_id, purge_at: until };
}

const RESTORE_DOCUMENT: CommandDefinition = {
  name: 'core.restore_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['content_id'],
    additionalProperties: false,
    properties: { content_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['content_id'],
    properties: { content_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'document_in_trash',
      sql: `SELECT count(*) AS n FROM core_content_item
             WHERE content_id = :content_id AND deleted_at IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'document_restored',
      sql: `SELECT count(*) AS n FROM core_content_item
             WHERE content_id = :content_id AND deleted_at IS NULL AND purge_at IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: restoreDocument,
};

function restoreDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { content_id: string };
  ctx.db
    .prepare('UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL WHERE content_id = ?')
    .run(input.content_id);
  ctx.wrote('core.content_item', input.content_id);
  return { content_id: input.content_id };
}

const CREATE_FOLDER: CommandDefinition = {
  name: 'core.create_folder',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      parent_folder_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['folder_id'],
    properties: { folder_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'parent_exists_if_given',
      sql: `SELECT CASE WHEN :parent_folder_id IS NULL THEN 1
                 ELSE EXISTS(SELECT 1 FROM core_concept c
                               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                              WHERE c.concept_id = :parent_folder_id AND s.uri = '${FOLDER_SCHEME_URI}')
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Sibling folders keep distinct names — a receipted refusal beats
      // two "Taxes" folders side by side.
      name: 'name_unused_among_siblings',
      sql: `SELECT count(*) AS n FROM core_concept c
              JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
             WHERE s.uri = '${FOLDER_SCHEME_URI}' AND c.pref_label = :name AND c.notation != 'root'
               AND ((:parent_folder_id IS NULL AND (c.broader_concept_id IS NULL
                       OR c.broader_concept_id IN (SELECT concept_id FROM core_concept WHERE notation = 'root' AND scheme_id = s.scheme_id)))
                    OR c.broader_concept_id = :parent_folder_id)`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'folder_created',
      sql: `SELECT count(*) AS n FROM core_concept WHERE concept_id = :folder_id AND pref_label = :name`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: createFolder,
};

function createFolder(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { name: string; parent_folder_id?: string };
  const schemeId = folderSchemeId(ctx);
  const parentId = input.parent_folder_id ?? rootFolderId(ctx);
  const folderId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
       VALUES (?, ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(folderId, schemeId, folderId, input.name, parentId);
  ctx.wrote('core.concept', folderId);
  return { folder_id: folderId };
}

const RENAME_FOLDER: CommandDefinition = {
  name: 'core.rename_folder',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['folder_id', 'name'],
    additionalProperties: false,
    properties: {
      folder_id: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['folder_id'],
    properties: { folder_id: { type: 'string' } },
  },
  preconditions: [
    {
      // The root's name is the drive's, not a folder's.
      name: 'folder_exists_and_not_root',
      sql: `SELECT count(*) AS n FROM core_concept c
              JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
             WHERE c.concept_id = :folder_id AND s.uri = '${FOLDER_SCHEME_URI}' AND c.notation != 'root'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'name_applied',
      sql: 'SELECT count(*) AS n FROM core_concept WHERE concept_id = :folder_id AND pref_label = :name',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: renameFolder,
};

function renameFolder(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { folder_id: string; name: string };
  ctx.db
    .prepare('UPDATE core_concept SET pref_label = ? WHERE concept_id = ?')
    .run(input.name, input.folder_id);
  ctx.wrote('core.concept', input.folder_id);
  return { folder_id: input.folder_id };
}

const DELETE_FOLDER: CommandDefinition = {
  name: 'core.delete_folder',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['folder_id'],
    additionalProperties: false,
    properties: { folder_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['folder_id'],
    properties: { folder_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'folder_exists_and_not_root',
      sql: `SELECT count(*) AS n FROM core_concept c
              JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
             WHERE c.concept_id = :folder_id AND s.uri = '${FOLDER_SCHEME_URI}' AND c.notation != 'root'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Only empty folders delete — move or trash the contents first.
      name: 'folder_is_empty',
      sql: `SELECT (
              EXISTS(SELECT 1 FROM core_tag WHERE concept_id = :folder_id)
              OR EXISTS(SELECT 1 FROM core_concept WHERE broader_concept_id = :folder_id)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'folder_removed',
      sql: 'SELECT count(*) AS n FROM core_concept WHERE concept_id = :folder_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: deleteFolder,
};

function deleteFolder(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { folder_id: string };
  ctx.db.prepare('DELETE FROM core_concept WHERE concept_id = ?').run(input.folder_id);
  ctx.wrote('core.concept', input.folder_id);
  return { folder_id: input.folder_id };
}

/** Register the document commands on a gateway. */
export function registerDocumentCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_DOCUMENT);
  gateway.registerCommand(RENAME_DOCUMENT);
  gateway.registerCommand(MOVE_DOCUMENT);
  gateway.registerCommand(TRASH_DOCUMENT);
  gateway.registerCommand(RESTORE_DOCUMENT);
  gateway.registerCommand(CREATE_FOLDER);
  gateway.registerCommand(RENAME_FOLDER);
  gateway.registerCommand(DELETE_FOLDER);
}
