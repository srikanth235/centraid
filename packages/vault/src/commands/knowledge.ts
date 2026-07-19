// governance: allow-repo-hygiene file-size-limit one file per life domain (§08) — the knowledge commands share the note-over-content-item mechanism and its dedup invariants
// Knowledge domain commands (§08): notes are references over canonical
// content — a knowledge_note row points at a core_content_item body, it
// never stores prose itself. Bodies follow the social.draft_message
// mechanism exactly: sha256-deduped, inlined as data: URIs (rent the bytes,
// own the reference). A notebook is a surface view over core_collection,
// the one owner-curation mechanism (issue #274) — these commands keep their
// contracts while storage unifies, so a collection may also hold photos and
// documents. Notebooks stay one-per-note in v1: the entry table allows
// many-to-many, but move_note keeps a single placement until a real
// multi-notebook surface asks for more.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { sha256Hex } from '../ids.js';
import { assertTextBodyWithinBudget } from './inline-body-guard.js';
import { releaseContentIfUnreferenced } from './media.js';
import { recordRevision } from './revisions.js';
import { cleanupPolyRefs } from '../schema/poly-refs.js';

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

const MEDIA_TYPE: Record<string, string> = {
  markdown: 'text/markdown',
  html: 'text/html',
  plain: 'text/plain',
};

/** Dedupe-or-insert a text body as a canonical content item (P2). */
export function contentItemFor(ctx: HandlerCtx, bodyText: string, format: string): string {
  const mediaType = MEDIA_TYPE[format] ?? 'text/plain';
  // Text bodies stay inline forever (the FTS trigger reads content_uri
  // in-transaction, no CAS redirect possible) — refuse rather than let an
  // unbounded note body bloat vault.db (issue #367 §E4).
  assertTextBodyWithinBudget(bodyText, mediaType);
  const sha = sha256Hex(bodyText);
  const existing = ctx.db
    .prepare('SELECT content_id FROM core_content_item WHERE sha256 = ?')
    .get(sha) as { content_id: string } | undefined;
  if (existing) return existing.content_id;
  const contentId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_content_item
         (content_id, media_type, content_uri, sha256, byte_size, title, language, creator_party_id, origin_device_id, deleted_at, purge_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
    )
    .run(
      contentId,
      mediaType,
      `data:${mediaType};charset=utf-8,${encodeURIComponent(bodyText)}`,
      sha,
      Buffer.from(bodyText, 'utf8').length,
      actorPartyId(ctx),
      ctx.now,
    );
  ctx.wrote('core.content_item', contentId);
  return contentId;
}

const CREATE_NOTE: CommandDefinition = {
  name: 'knowledge.create_note',
  ownerSchema: 'knowledge',
  inputSchema: {
    type: 'object',
    required: ['title', 'body_text'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1 },
      body_text: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['markdown', 'html', 'plain'] },
      notebook_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['note_id', 'body_content_id'],
    properties: { note_id: { type: 'string' }, body_content_id: { type: 'string' } },
  },
  preconditions: [
    {
      // Filing is optional; a named notebook must exist. Optional inputs
      // bind as NULL, so an unfiled create passes trivially.
      name: 'notebook_exists_if_given',
      sql: `SELECT CASE WHEN :notebook_id IS NULL THEN 1
                 ELSE (SELECT count(*) FROM core_collection WHERE collection_id = :notebook_id)
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // The note exists, unpinned, and is placed iff a notebook was named.
      name: 'note_created_and_placed',
      sql: `SELECT (
              (SELECT count(*) FROM knowledge_note WHERE note_id = :note_id AND pinned = 0)
              AND (SELECT CASE WHEN :notebook_id IS NULL
                     THEN NOT EXISTS(SELECT 1 FROM core_collection_entry
                                      WHERE target_type = 'knowledge.note' AND target_id = :note_id)
                     ELSE EXISTS(SELECT 1 FROM core_collection_entry
                                  WHERE target_type = 'knowledge.note' AND target_id = :note_id
                                    AND collection_id = :notebook_id) END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: createNote,
};

function createNote(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    title: string;
    body_text: string;
    format?: string;
    notebook_id?: string;
  };
  const format = input.format ?? 'plain';
  const contentId = contentItemFor(ctx, input.body_text, format);
  const noteId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO knowledge_note (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(noteId, actorPartyId(ctx), input.title, contentId, format, ctx.now, ctx.now);
  ctx.wrote('knowledge.note', noteId);
  if (input.notebook_id) {
    placeNote(ctx, noteId, input.notebook_id);
  }
  return { note_id: noteId, body_content_id: contentId };
}

/** File a note at the end of a collection (one ordered list, all types). */
function placeNote(ctx: HandlerCtx, noteId: string, notebookId: string): void {
  const entryId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_collection_entry (entry_id, collection_id, target_type, target_id, position, added_at)
       VALUES (?, ?, 'knowledge.note', ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM core_collection_entry WHERE collection_id = ?), ?)`,
    )
    .run(entryId, notebookId, noteId, notebookId, ctx.now);
  ctx.wrote('core.collection_entry', entryId);
}

const EDIT_NOTE: CommandDefinition = {
  name: 'knowledge.edit_note',
  ownerSchema: 'knowledge',
  inputSchema: {
    type: 'object',
    required: ['note_id'],
    additionalProperties: false,
    properties: {
      note_id: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
      body_text: { type: 'string', minLength: 1 },
      format: { type: 'string', enum: ['markdown', 'html', 'plain'] },
      // Pinning folds into edit rather than a command of its own: it is a
      // flag with no lifecycle, unlike task status.
      pinned: { type: 'integer', minimum: 0, maximum: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['note_id'],
    properties: { note_id: { type: 'string' }, body_content_id: { type: 'string' } },
  },
  preconditions: [
    {
      // A trashed note is frozen: restore first, then edit.
      name: 'note_is_live',
      sql: 'SELECT count(*) AS n FROM knowledge_note WHERE note_id = :note_id AND deleted_at IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Each field either wasn't asked for, or now reads back exactly as
      // sent. Optional inputs bind as NULL so untouched fields pass.
      name: 'edits_applied',
      sql: `SELECT (
              (SELECT CASE WHEN :title IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM knowledge_note WHERE note_id = :note_id AND title = :title) END)
              AND (SELECT CASE WHEN :format IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM knowledge_note WHERE note_id = :note_id AND format = :format) END)
              AND (SELECT CASE WHEN :pinned IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM knowledge_note WHERE note_id = :note_id AND pinned = :pinned) END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: editNote,
};

function editNote(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    note_id: string;
    title?: string;
    body_text?: string;
    format?: string;
    pinned?: number;
  };
  const current = ctx.db
    .prepare('SELECT format, body_content_id FROM knowledge_note WHERE note_id = ?')
    .get(input.note_id) as { format: string; body_content_id: string } | undefined;
  if (!current) throw new Error('note vanished between check and execute');
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number)[] = [ctx.now];
  let contentId: string | undefined;
  if (input.body_text !== undefined) {
    // A body edit re-resolves the reference: new (or deduped) content item,
    // decoded with the format the note will have after this edit. Heals the
    // notes/docs divergence (issue #352): a genuine bump gets the same
    // `revises` link core.edit_document records, so a note's edit history is
    // walkable through core_link exactly like a document's.
    contentId = contentItemFor(ctx, input.body_text, input.format ?? current.format);
    if (contentId !== current.body_content_id) {
      recordRevision(ctx, contentId, current.body_content_id);
    }
    sets.push('body_content_id = ?');
    values.push(contentId);
  }
  if (input.title !== undefined) {
    sets.push('title = ?');
    values.push(input.title);
  }
  if (input.format !== undefined) {
    sets.push('format = ?');
    values.push(input.format);
  }
  if (input.pinned !== undefined) {
    sets.push('pinned = ?');
    values.push(input.pinned);
  }
  ctx.db
    .prepare(`UPDATE knowledge_note SET ${sets.join(', ')} WHERE note_id = ?`)
    .run(...values, input.note_id);
  ctx.wrote('knowledge.note', input.note_id);
  return { note_id: input.note_id, ...(contentId ? { body_content_id: contentId } : {}) };
}

const MOVE_NOTE: CommandDefinition = {
  name: 'knowledge.move_note',
  ownerSchema: 'knowledge',
  inputSchema: {
    type: 'object',
    required: ['note_id'],
    additionalProperties: false,
    properties: {
      note_id: { type: 'string', minLength: 1 },
      // Omitting notebook_id unfiles the note — moving out is as explicit
      // an intent as moving in.
      notebook_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['note_id'],
    properties: { note_id: { type: 'string' } },
  },
  preconditions: [
    {
      // A trashed note is frozen: restore first, then move.
      name: 'note_is_live',
      sql: 'SELECT count(*) AS n FROM knowledge_note WHERE note_id = :note_id AND deleted_at IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'notebook_exists_if_given',
      sql: `SELECT CASE WHEN :notebook_id IS NULL THEN 1
                 ELSE (SELECT count(*) FROM core_collection WHERE collection_id = :notebook_id)
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // One placement in the target notebook, or none at all if unfiled.
      name: 'note_singly_placed',
      sql: `SELECT CASE WHEN :notebook_id IS NULL
                 THEN NOT EXISTS(SELECT 1 FROM core_collection_entry
                                  WHERE target_type = 'knowledge.note' AND target_id = :note_id)
                 ELSE (SELECT count(*) FROM core_collection_entry
                        WHERE target_type = 'knowledge.note' AND target_id = :note_id) = 1
                      AND EXISTS(SELECT 1 FROM core_collection_entry
                                  WHERE target_type = 'knowledge.note' AND target_id = :note_id
                                    AND collection_id = :notebook_id)
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: moveNote,
};

function moveNote(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { note_id: string; notebook_id?: string };
  ctx.db
    .prepare(
      `DELETE FROM core_collection_entry WHERE target_type = 'knowledge.note' AND target_id = ?`,
    )
    .run(input.note_id);
  if (input.notebook_id) {
    placeNote(ctx, input.note_id, input.notebook_id);
  }
  ctx.wrote('knowledge.note', input.note_id);
  return { note_id: input.note_id };
}

const CREATE_NOTEBOOK: CommandDefinition = {
  name: 'knowledge.create_notebook',
  ownerSchema: 'knowledge',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 1 },
      parent_notebook_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['notebook_id'],
    properties: { notebook_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'parent_exists_if_given',
      sql: `SELECT CASE WHEN :parent_notebook_id IS NULL THEN 1
                 ELSE (SELECT count(*) FROM core_collection WHERE collection_id = :parent_notebook_id)
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Same collision rule rename_notebook already enforces: two notebooks
      // with the same name are indistinguishable in every filing UI, so
      // refuse at create too — otherwise the duplicate can only be untangled
      // by renaming one away, and rename itself refuses the colliding name.
      name: 'name_unused',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE name = :name',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'notebook_created',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :notebook_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: createNotebook,
};

function createNotebook(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { name: string; parent_notebook_id?: string };
  const notebookId = ctx.newId();
  ctx.db
    .prepare(
      // sort_order is sibling-scoped; IS (not =) so NULL parents group too.
      `INSERT INTO core_collection (collection_id, owner_party_id, name, cover_content_id, parent_collection_id, sort_order, created_at)
       VALUES (?, ?, ?, NULL, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM core_collection
                             WHERE parent_collection_id IS ?), ?)`,
    )
    .run(
      notebookId,
      actorPartyId(ctx),
      input.name,
      input.parent_notebook_id ?? null,
      input.parent_notebook_id ?? null,
      ctx.now,
    );
  ctx.wrote('core.collection', notebookId);
  return { notebook_id: notebookId };
}

const RENAME_NOTEBOOK: CommandDefinition = {
  name: 'knowledge.rename_notebook',
  ownerSchema: 'knowledge',
  inputSchema: {
    type: 'object',
    required: ['notebook_id', 'name'],
    additionalProperties: false,
    properties: {
      notebook_id: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['notebook_id'],
    properties: { notebook_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'notebook_exists',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :notebook_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // The schema has no UNIQUE on name, but two notebooks with the same
      // name are indistinguishable in every filing UI — refuse the collision
      // here. Scoped to the same owner, and excluding the notebook itself so
      // a rename to its current name is an idempotent no-op.
      name: 'name_unused_by_owner',
      sql: `SELECT count(*) AS n FROM core_collection
             WHERE name = :name AND collection_id <> :notebook_id
               AND owner_party_id = (SELECT owner_party_id FROM core_collection
                                      WHERE collection_id = :notebook_id)`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'name_updated',
      sql: `SELECT count(*) AS n FROM core_collection
             WHERE collection_id = :notebook_id AND name = :name`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: renameNotebook,
};

function renameNotebook(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { notebook_id: string; name: string };
  ctx.db
    .prepare('UPDATE core_collection SET name = ? WHERE collection_id = ?')
    .run(input.name, input.notebook_id);
  ctx.wrote('core.collection', input.notebook_id);
  return { notebook_id: input.notebook_id };
}

const DELETE_NOTEBOOK: CommandDefinition = {
  name: 'knowledge.delete_notebook',
  ownerSchema: 'knowledge',
  inputSchema: {
    type: 'object',
    required: ['notebook_id'],
    additionalProperties: false,
    properties: { notebook_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['notebook_id', 'notes_unfiled'],
    properties: {
      notebook_id: { type: 'string' },
      notes_unfiled: { type: 'integer' },
    },
  },
  preconditions: [
    {
      name: 'notebook_exists',
      sql: 'SELECT count(*) AS n FROM core_collection WHERE collection_id = :notebook_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Hierarchy never dangles: children must be deleted (or re-parented
      // by hand) first, mirroring how create_notebook refuses a missing
      // parent on the way in.
      name: 'notebook_has_no_children',
      sql: `SELECT count(*) AS n FROM core_collection
             WHERE parent_collection_id = :notebook_id`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      // The collection and every entry onto it are gone together; members
      // survive as unfiled rows (entries are the only edge).
      name: 'notebook_and_placements_removed',
      sql: `SELECT (
              (SELECT count(*) FROM core_collection WHERE collection_id = :notebook_id)
              + (SELECT count(*) FROM core_collection_entry WHERE collection_id = :notebook_id)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  // Unfile, don't destroy: the notebook is pure structure — deleting it
  // orphans no content and every member note survives, so this sits at
  // low alongside delete_note (which destroys strictly more).
  risk: 'low',
  handler: deleteNotebook,
};

function deleteNotebook(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { notebook_id: string };
  const filed = ctx.db
    .prepare(
      `SELECT count(*) AS n FROM core_collection_entry
        WHERE collection_id = ? AND target_type = 'knowledge.note'`,
    )
    .get(input.notebook_id) as { n: number };
  ctx.db
    .prepare('DELETE FROM core_collection_entry WHERE collection_id = ?')
    .run(input.notebook_id);
  ctx.db.prepare('DELETE FROM core_collection WHERE collection_id = ?').run(input.notebook_id);
  cleanupPolyRefs(ctx.db, ctx.now, 'core.collection', input.notebook_id);
  ctx.wrote('core.collection', input.notebook_id);
  ctx.cite({
    claim: `notebook ${input.notebook_id} deleted; ${filed.n} member notes unfiled, none destroyed`,
    entityType: 'core.collection',
    entityId: input.notebook_id,
  });
  return { notebook_id: input.notebook_id, notes_unfiled: filed.n };
}

// Delete is TRASH (issue #308 A6): Tier 1's consent story is
// review-after-the-fact WITH undo, so the destructive verb must be
// reversible from the review feed. The row soft-deletes with the same
// 30-day grace window documents and assets carry; edges (placement,
// annotations, attachments) stay for a faithful restore; the lifecycle
// sweep performs the real deletion once the window lapses.
const DELETE_NOTE: CommandDefinition = {
  name: 'knowledge.delete_note',
  ownerSchema: 'knowledge',
  inputSchema: {
    type: 'object',
    required: ['note_id'],
    additionalProperties: false,
    properties: { note_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['note_id', 'purge_at'],
    properties: {
      note_id: { type: 'string' },
      purge_at: { type: 'string' },
      body_released: { type: 'integer' },
    },
  },
  preconditions: [
    {
      name: 'note_is_live',
      sql: 'SELECT count(*) AS n FROM knowledge_note WHERE note_id = :note_id AND deleted_at IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'note_trashed_not_destroyed',
      sql: `SELECT count(*) AS n FROM knowledge_note
             WHERE note_id = :note_id AND deleted_at IS NOT NULL AND purge_at IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: deleteNote,
};

const NOTE_PURGE_AFTER_DAYS = 30;

function notePurgeAt(now: string): string {
  return new Date(
    new Date(now).getTime() + NOTE_PURGE_AFTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
}

function deleteNote(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { note_id: string };
  const note = ctx.db
    .prepare('SELECT body_content_id FROM knowledge_note WHERE note_id = ?')
    .get(input.note_id) as { body_content_id: string } | undefined;
  if (!note) throw new Error('note vanished between check and execute');
  const until = notePurgeAt(ctx.now);
  ctx.db
    .prepare(
      'UPDATE knowledge_note SET deleted_at = ?, purge_at = ?, updated_at = ? WHERE note_id = ?',
    )
    .run(ctx.now, until, ctx.now, input.note_id);
  ctx.wrote('knowledge.note', input.note_id);
  // Bodies are sha256-deduped and canonical — another live note or message
  // may still rent the same bytes, so only an unreferenced body soft-deletes
  // (a trashed note is not a rental; restore un-trashes the body with it).
  const released = releaseContentIfUnreferenced(ctx, note.body_content_id);
  ctx.cite({
    claim: `note ${input.note_id} moved to trash (restore with knowledge.restore_note); purges after ${until.slice(0, 10)}; body ${released ? 'soft-deleted' : 'still rented elsewhere'}`,
    entityType: 'knowledge.note',
    entityId: input.note_id,
  });
  return { note_id: input.note_id, purge_at: until, body_released: released ? 1 : 0 };
}

// The undo half (issue #308 A6): a trashed note comes back whole — row,
// placement, annotations, attachments (never removed) and its body bytes.
const RESTORE_NOTE: CommandDefinition = {
  name: 'knowledge.restore_note',
  ownerSchema: 'knowledge',
  inputSchema: {
    type: 'object',
    required: ['note_id'],
    additionalProperties: false,
    properties: { note_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['note_id'],
    properties: { note_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'note_in_trash',
      sql: `SELECT count(*) AS n FROM knowledge_note
             WHERE note_id = :note_id AND deleted_at IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'note_restored',
      sql: `SELECT count(*) AS n FROM knowledge_note
             WHERE note_id = :note_id AND deleted_at IS NULL AND purge_at IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: restoreNote,
};

function restoreNote(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { note_id: string };
  const note = ctx.db
    .prepare('SELECT body_content_id FROM knowledge_note WHERE note_id = ?')
    .get(input.note_id) as { body_content_id: string } | undefined;
  if (!note) throw new Error('note vanished between check and execute');
  ctx.db
    .prepare(
      'UPDATE knowledge_note SET deleted_at = NULL, purge_at = NULL, updated_at = ? WHERE note_id = ?',
    )
    .run(ctx.now, input.note_id);
  ctx.wrote('knowledge.note', input.note_id);
  // If trashing released the body bytes, restoring rents them again.
  const body = ctx.db
    .prepare(
      'UPDATE core_content_item SET deleted_at = NULL, purge_at = NULL WHERE content_id = ? AND deleted_at IS NOT NULL',
    )
    .run(note.body_content_id);
  if (Number(body.changes) > 0) ctx.wrote('core.content_item', note.body_content_id);
  ctx.cite({
    claim: `note ${input.note_id} restored from trash`,
    entityType: 'knowledge.note',
    entityId: input.note_id,
  });
  return { note_id: input.note_id };
}

/** Register the knowledge domain's commands on a gateway. */
export function registerKnowledgeCommands(gateway: Gateway): void {
  gateway.registerCommand(CREATE_NOTE);
  gateway.registerCommand(EDIT_NOTE);
  gateway.registerCommand(MOVE_NOTE);
  gateway.registerCommand(CREATE_NOTEBOOK);
  gateway.registerCommand(RENAME_NOTEBOOK);
  gateway.registerCommand(DELETE_NOTEBOOK);
  gateway.registerCommand(DELETE_NOTE);
  gateway.registerCommand(RESTORE_NOTE);
}
