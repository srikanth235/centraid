// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); documents own the whole drive loop (13 commands with their contracts), so it is large by design.
// Document commands (core §01, issue #352): a document has identity SEPARATE
// from its bytes — core_document wraps a canonical core_content_item exactly
// like knowledge_note wraps a note body (the wrapper pattern), so a document
// can be edited in place with a walkable version history instead of forcing
// every edit to mint a brand-new document. Folders are SKOS concepts in the
// owner's centraid folders scheme (broader_concept_id is the parent), and
// filing is one core_tag row per document — everything the ontology already
// models, nothing invented. The scheme's `root` concept is the drive's top
// level; every document carries exactly one folders-scheme tag.
//
// Version lineage is a `revises` core.link between CONTENT ITEMS (NEW ->
// OLD, issue #272's relation fabric), never a column on core_document —
// core_document.current_content_id only ever names the HEAD; the chain
// behind it is walked through core_link. History never rewrites (rule R3):
// restoring an old version asserts a new link forward, it never touches the
// old ones. Trash is the DOCUMENT row's own deleted_at/purge_at lifecycle;
// superseded content items are durable — never auto-purged while their
// document lives — and purge with the document only once nothing else still
// needs them (gateway/duties.ts sweepLifecycle's lapsedDocuments pass).

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { MAX_INLINE_DATA_URI_CHARS, mintContentFromDataUri } from '../blob/mint.js';
import { setStarred, starredExistsSql } from './flags.js';
import { RELATIONS_SCHEME_URI_SQL } from './links.js';
import { recordRevision } from './revisions.js';

/** Soft-deleted documents linger this long before the lifecycle sweep purges. */
const PURGE_AFTER_DAYS = 30;

// An https URI, not a urn: one — this literal is interpolated into
// condition SQL, where `:folders` would read as a named parameter.
export const FOLDER_SCHEME_URI = 'https://centraid.dev/schemes/folders';

/** Document identity marks the wrapper row, never the raw content item. */
const DOCUMENT_TARGET_TYPE = 'core.document';

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
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

/** Re-file a document: exactly one folders-scheme tag per document. */
function fileInto(ctx: HandlerCtx, documentId: string, folderConceptId: string): void {
  ctx.db
    .prepare(
      `DELETE FROM core_tag
        WHERE target_type = '${DOCUMENT_TARGET_TYPE}' AND target_id = ?
          AND concept_id IN (SELECT c.concept_id FROM core_concept c
                               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                              WHERE s.uri = ?)`,
    )
    .run(documentId, FOLDER_SCHEME_URI);
  const tagId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
       VALUES (?, '${DOCUMENT_TARGET_TYPE}', ?, ?, ?, NULL, ?)`,
    )
    .run(tagId, documentId, folderConceptId, actorPartyId(ctx), ctx.now);
  ctx.wrote('core.tag', tagId);
}

/** Condition fragment: the id is a live document. */
const DOCUMENT_EXISTS_SQL = `
  SELECT count(*) AS n FROM core_document WHERE document_id = :document_id AND deleted_at IS NULL`;

/** Condition fragment: `:content_id` is the current content of `:document_id`. */
const IS_CURRENT_CONTENT_SQL = `
  SELECT count(*) AS n FROM core_document
   WHERE document_id = :document_id AND current_content_id = :content_id`;

const ADD_DOCUMENT: CommandDefinition = {
  name: 'core.add_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['title'],
    additionalProperties: false,
    properties: {
      /** Small inline bytes. Exactly one of data_uri / staged_sha (#296). */
      data_uri: { type: 'string', minLength: 6 },
      /** Staged bytes: claim what POST /_vault/blobs hashed into the CAS. */
      staged_sha: { type: 'string', minLength: 64, maxLength: 64 },
      title: { type: 'string', minLength: 1 },
      folder_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id', 'content_id'],
    properties: {
      document_id: { type: 'string' },
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
      // The inline door is for SMALL payloads (issue #296): the journal
      // records every input, so big documents take the staging route.
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
      sql: `
        SELECT count(*) AS n FROM core_document d
         WHERE d.document_id = :document_id AND d.deleted_at IS NULL
           AND EXISTS(SELECT 1 FROM core_tag t
                        JOIN core_concept c ON c.concept_id = t.concept_id
                        JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                       WHERE t.target_type = '${DOCUMENT_TARGET_TYPE}' AND t.target_id = d.document_id
                         AND s.uri = '${FOLDER_SCHEME_URI}')`,
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
  const input = ctx.input as {
    data_uri?: string;
    staged_sha?: string;
    title: string;
    folder_id?: string;
  };
  // Staged bytes claim their content item (issue #296); small inline
  // payloads mint one. A document's identity is the wrapper row, not the
  // content item — re-presenting known bytes dedupes the BYTES (deduped: 1)
  // but always mints a fresh document, because two documents may
  // legitimately share identical bytes.
  const minted = input.staged_sha
    ? ctx.blobs.claimStaged(input.staged_sha, { title: input.title })
    : mintContentFromDataUri(ctx, input.data_uri!, { title: input.title });
  const contentId = minted.contentId;
  ctx.wrote('core.content_item', contentId);
  const documentId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_document (document_id, title, current_content_id, created_at, updated_at, deleted_at, purge_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(documentId, input.title, contentId, ctx.now, ctx.now);
  ctx.wrote('core.document', documentId);
  fileInto(ctx, documentId, input.folder_id ?? rootFolderId(ctx));
  ctx.cite({
    claim: `"${input.title}" (${minted.mediaType}, ${minted.byteSize} bytes) filed into the drive`,
    entityType: 'core.document',
    entityId: documentId,
  });
  return { document_id: documentId, content_id: contentId, deduped: minted.deduped };
}

const RENAME_DOCUMENT: CommandDefinition = {
  name: 'core.rename_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id', 'title'],
    additionalProperties: false,
    properties: {
      document_id: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id'],
    properties: { document_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'title_applied',
      sql: 'SELECT count(*) AS n FROM core_document WHERE document_id = :document_id AND title = :title',
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
  const input = ctx.input as { document_id: string; title: string };
  ctx.db
    .prepare('UPDATE core_document SET title = ?, updated_at = ? WHERE document_id = ?')
    .run(input.title, ctx.now, input.document_id);
  ctx.wrote('core.document', input.document_id);
  return { document_id: input.document_id };
}

const MOVE_DOCUMENT: CommandDefinition = {
  name: 'core.move_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id'],
    additionalProperties: false,
    properties: {
      document_id: { type: 'string', minLength: 1 },
      // Omitted folder_id means back to the drive's top level.
      folder_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id'],
    properties: { document_id: { type: 'string' } },
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
             WHERE t.target_type = '${DOCUMENT_TARGET_TYPE}' AND t.target_id = :document_id
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
  const input = ctx.input as { document_id: string; folder_id?: string };
  fileInto(ctx, input.document_id, input.folder_id ?? rootFolderId(ctx));
  ctx.wrote('core.document', input.document_id);
  return { document_id: input.document_id };
}

const TRASH_DOCUMENT: CommandDefinition = {
  name: 'core.trash_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id'],
    additionalProperties: false,
    properties: { document_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id', 'purge_at'],
    properties: { document_id: { type: 'string' }, purge_at: { type: 'string' } },
  },
  preconditions: [
    // Only a live document can be trashed — a double-delete fails loudly
    // instead of silently re-stamping the trash date.
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'document_trashed',
      sql: `SELECT count(*) AS n FROM core_document
             WHERE document_id = :document_id AND deleted_at IS NOT NULL AND purge_at IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: trashDocument,
};

function trashDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { document_id: string };
  const until = purgeAt(ctx.now);
  // Content is untouched here (retention stance, issue #352): the wrapper
  // trashes, its bytes — current AND every superseded revision — stay live
  // until the document itself purges (gateway/duties.ts lapsedDocuments).
  ctx.db
    .prepare('UPDATE core_document SET deleted_at = ?, purge_at = ?, updated_at = ? WHERE document_id = ?')
    .run(ctx.now, until, ctx.now, input.document_id);
  ctx.wrote('core.document', input.document_id);
  ctx.cite({
    claim: `document ${input.document_id} moved to trash; purges after ${until.slice(0, 10)}`,
    entityType: 'core.document',
    entityId: input.document_id,
  });
  return { document_id: input.document_id, purge_at: until };
}

const RESTORE_DOCUMENT: CommandDefinition = {
  name: 'core.restore_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id'],
    additionalProperties: false,
    properties: { document_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id'],
    properties: { document_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'document_in_trash',
      sql: `SELECT count(*) AS n FROM core_document
             WHERE document_id = :document_id AND deleted_at IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'document_restored',
      sql: `SELECT count(*) AS n FROM core_document
             WHERE document_id = :document_id AND deleted_at IS NULL AND purge_at IS NULL`,
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
  const input = ctx.input as { document_id: string };
  ctx.db
    .prepare(
      'UPDATE core_document SET deleted_at = NULL, purge_at = NULL, updated_at = ? WHERE document_id = ?',
    )
    .run(ctx.now, input.document_id);
  ctx.wrote('core.document', input.document_id);
  return { document_id: input.document_id };
}

const STAR_DOCUMENT: CommandDefinition = {
  name: 'core.star_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id'],
    additionalProperties: false,
    properties: { document_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id'],
    properties: { document_id: { type: 'string' } },
  },
  preconditions: [
    // A trashed document refuses state changes (same rule as rename/move),
    // but an already-starred one keeps its tag through trash and restore.
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'document_starred',
      sql: `SELECT ${starredExistsSql(DOCUMENT_TARGET_TYPE, ':document_id')} AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: starDocument,
};

function starDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { document_id: string };
  setStarred(ctx, DOCUMENT_TARGET_TYPE, input.document_id, true);
  ctx.wrote('core.document', input.document_id);
  return { document_id: input.document_id };
}

const UNSTAR_DOCUMENT: CommandDefinition = {
  name: 'core.unstar_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id'],
    additionalProperties: false,
    properties: { document_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id'],
    properties: { document_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'document_unstarred',
      sql: `SELECT ${starredExistsSql(DOCUMENT_TARGET_TYPE, ':document_id')} AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: unstarDocument,
};

function unstarDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { document_id: string };
  setStarred(ctx, DOCUMENT_TARGET_TYPE, input.document_id, false);
  ctx.wrote('core.document', input.document_id);
  return { document_id: input.document_id };
}

const EDIT_DOCUMENT: CommandDefinition = {
  name: 'core.edit_document',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id', 'body_text'],
    additionalProperties: false,
    properties: {
      document_id: { type: 'string', minLength: 1 },
      body_text: { type: 'string' },
      title: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id', 'content_id'],
    properties: { document_id: { type: 'string' }, content_id: { type: 'string' } },
  },
  preconditions: [
    // A trashed document is frozen: restore first, then edit.
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
    {
      // Only text-editable media types take the structured body_text door;
      // a scanned PDF or image goes through replace_document_content.
      name: 'current_content_is_text',
      sql: `SELECT count(*) AS n FROM core_document d
              JOIN core_content_item c ON c.content_id = d.current_content_id
             WHERE d.document_id = :document_id AND c.media_type LIKE 'text/%'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'edit_applied',
      sql: `SELECT (
              EXISTS(SELECT 1 FROM core_document d
                       JOIN core_content_item c ON c.content_id = d.current_content_id
                      WHERE d.document_id = :document_id
                        AND vault_content_text(c.media_type, c.content_uri) = :body_text)
              AND (SELECT CASE WHEN :title IS NULL THEN 1
                     ELSE EXISTS(SELECT 1 FROM core_document WHERE document_id = :document_id AND title = :title) END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: editDocument,
};

function editDocument(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { document_id: string; body_text: string; title?: string };
  const doc = ctx.db
    .prepare(
      `SELECT d.current_content_id AS content_id, c.media_type AS media_type
         FROM core_document d JOIN core_content_item c ON c.content_id = d.current_content_id
        WHERE d.document_id = ?`,
    )
    .get(input.document_id) as { content_id: string; media_type: string } | undefined;
  if (!doc) throw new Error('document vanished between check and execute');
  // Same mint path add_document takes (issue #296): text stays inline, the
  // FTS triggers decode it in-transaction. The media type carries forward —
  // an edit changes the words, never the format.
  const dataUri = `data:${doc.media_type};charset=utf-8,${encodeURIComponent(input.body_text)}`;
  const minted = mintContentFromDataUri(ctx, dataUri, {});
  const sets: string[] = ['updated_at = ?'];
  const values: string[] = [ctx.now];
  if (minted.contentId !== doc.content_id) {
    recordRevision(ctx, minted.contentId, doc.content_id);
    sets.push('current_content_id = ?');
    values.push(minted.contentId);
  }
  if (input.title !== undefined) {
    sets.push('title = ?');
    values.push(input.title);
  }
  ctx.db
    .prepare(`UPDATE core_document SET ${sets.join(', ')} WHERE document_id = ?`)
    .run(...values, input.document_id);
  ctx.wrote('core.document', input.document_id);
  ctx.cite({
    claim:
      minted.contentId !== doc.content_id
        ? `document ${input.document_id} edited; new revision ${minted.contentId} revises ${doc.content_id}`
        : `document ${input.document_id} edited; bytes unchanged (dedup)`,
    entityType: 'core.document',
    entityId: input.document_id,
  });
  return { document_id: input.document_id, content_id: minted.contentId };
}

const REPLACE_DOCUMENT_CONTENT: CommandDefinition = {
  name: 'core.replace_document_content',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id'],
    additionalProperties: false,
    properties: {
      document_id: { type: 'string', minLength: 1 },
      /** Small inline bytes. Exactly one of data_uri / staged_sha (#296). */
      data_uri: { type: 'string', minLength: 6 },
      /** Staged bytes: claim what POST /_vault/blobs hashed into the CAS. */
      staged_sha: { type: 'string', minLength: 64, maxLength: 64 },
      title: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id', 'content_id'],
    properties: { document_id: { type: 'string' }, content_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
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
      name: 'content_replaced',
      sql: `SELECT (
              EXISTS(SELECT 1 FROM core_document WHERE document_id = :document_id AND current_content_id = :content_id)
              AND (SELECT CASE WHEN :title IS NULL THEN 1
                     ELSE EXISTS(SELECT 1 FROM core_document WHERE document_id = :document_id AND title = :title) END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: replaceDocumentContent,
};

function replaceDocumentContent(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    document_id: string;
    data_uri?: string;
    staged_sha?: string;
    title?: string;
  };
  const doc = ctx.db
    .prepare('SELECT current_content_id FROM core_document WHERE document_id = ?')
    .get(input.document_id) as { current_content_id: string } | undefined;
  if (!doc) throw new Error('document vanished between check and execute');
  const minted = input.staged_sha
    ? ctx.blobs.claimStaged(input.staged_sha, {})
    : mintContentFromDataUri(ctx, input.data_uri!, {});
  const contentId = minted.contentId;
  ctx.wrote('core.content_item', contentId);
  const sets: string[] = ['updated_at = ?'];
  const values: string[] = [ctx.now];
  if (contentId !== doc.current_content_id) {
    recordRevision(ctx, contentId, doc.current_content_id);
    sets.push('current_content_id = ?');
    values.push(contentId);
  }
  if (input.title !== undefined) {
    sets.push('title = ?');
    values.push(input.title);
  }
  ctx.db
    .prepare(`UPDATE core_document SET ${sets.join(', ')} WHERE document_id = ?`)
    .run(...values, input.document_id);
  ctx.wrote('core.document', input.document_id);
  ctx.cite({
    claim:
      contentId !== doc.current_content_id
        ? `document ${input.document_id} content replaced; new revision ${contentId} revises ${doc.current_content_id}`
        : `document ${input.document_id} content replaced; bytes unchanged (dedup)`,
    entityType: 'core.document',
    entityId: input.document_id,
  });
  return { document_id: input.document_id, content_id: contentId };
}

// core.document_history is deliberately NOT a command — the chain is a plain
// read: walk core_link WHERE from_type='core.content_item' AND relation
// notation 'revises' starting at the document's current_content_id. See
// documents.test.ts for the exact SQL an app-plane read would run.
const RESTORE_DOCUMENT_VERSION: CommandDefinition = {
  name: 'core.restore_document_version',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['document_id', 'content_id'],
    additionalProperties: false,
    properties: {
      document_id: { type: 'string', minLength: 1 },
      /** A content item in this document's own history, not the current one. */
      content_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['document_id', 'content_id'],
    properties: { document_id: { type: 'string' }, content_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'document_exists', sql: DOCUMENT_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
    {
      name: 'not_already_current',
      sql: IS_CURRENT_CONTENT_SQL,
      column: 'n',
      op: 'eq',
      value: 0,
    },
    {
      // The target must be a genuine ancestor of the current content, walked
      // through live `revises` links — never an arbitrary content item.
      // Restoring an old version can make that version's content id gain a
      // NEW outgoing edge (restore IS a revision, rule R3), which cycles the
      // graph back through content already visited — UNION (not UNION ALL)
      // is load-bearing here: SQLite's recursive CTE drops repeat rows, so
      // the walk still terminates instead of looping the cycle forever.
      name: 'target_in_chain',
      sql: `WITH RECURSIVE chain(content_id) AS (
              SELECT current_content_id FROM core_document WHERE document_id = :document_id
              UNION
              SELECT l.to_id FROM core_link l
                JOIN chain ON l.from_type = 'core.content_item' AND l.from_id = chain.content_id
               WHERE l.to_type = 'core.content_item' AND l.valid_to IS NULL
                 AND l.relation_concept_id = (SELECT c.concept_id FROM core_concept c
                      JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                     WHERE s.uri = ${RELATIONS_SCHEME_URI_SQL} AND c.notation = 'revises')
            )
            SELECT count(*) AS n FROM chain WHERE content_id = :content_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'restored_and_recorded',
      sql: `SELECT (
              EXISTS(SELECT 1 FROM core_document
                      WHERE document_id = :document_id AND current_content_id = :content_id)
              AND EXISTS(SELECT 1 FROM core_link l
                          WHERE l.from_type = 'core.content_item' AND l.from_id = :content_id
                            AND l.to_type = 'core.content_item' AND l.valid_to IS NULL
                            AND l.relation_concept_id = (SELECT c.concept_id FROM core_concept c
                                 JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                                WHERE s.uri = ${RELATIONS_SCHEME_URI_SQL} AND c.notation = 'revises'))
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: restoreDocumentVersion,
};

function restoreDocumentVersion(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { document_id: string; content_id: string };
  const doc = ctx.db
    .prepare('SELECT current_content_id FROM core_document WHERE document_id = ?')
    .get(input.document_id) as { current_content_id: string } | undefined;
  if (!doc) throw new Error('document vanished between check and execute');
  // Restore is itself a new revision (rule R3): the old chain stays exactly
  // as it was, and this link only ever appends forward.
  recordRevision(ctx, input.content_id, doc.current_content_id);
  ctx.db
    .prepare('UPDATE core_document SET current_content_id = ?, updated_at = ? WHERE document_id = ?')
    .run(input.content_id, ctx.now, input.document_id);
  ctx.wrote('core.document', input.document_id);
  ctx.cite({
    claim: `document ${input.document_id} restored to prior version ${input.content_id}`,
    entityType: 'core.document',
    entityId: input.document_id,
  });
  return { document_id: input.document_id, content_id: input.content_id };
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
  gateway.registerCommand(STAR_DOCUMENT);
  gateway.registerCommand(UNSTAR_DOCUMENT);
  gateway.registerCommand(EDIT_DOCUMENT);
  gateway.registerCommand(REPLACE_DOCUMENT_CONTENT);
  gateway.registerCommand(RESTORE_DOCUMENT_VERSION);
  gateway.registerCommand(CREATE_FOLDER);
  gateway.registerCommand(RENAME_FOLDER);
  gateway.registerCommand(DELETE_FOLDER);
}
