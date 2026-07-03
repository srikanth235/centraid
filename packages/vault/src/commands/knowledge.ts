// Knowledge domain commands (§08): notes are references over canonical
// content — a knowledge_note row points at a core_content_item body, it
// never stores prose itself. Bodies follow the social.draft_message
// mechanism exactly: sha256-deduped, inlined as data: URIs (rent the bytes,
// own the reference). Notebooks are one-per-note in v1: the placement join
// table allows many-to-many, but move_note keeps a single placement until
// a real multi-notebook surface asks for more. knowledge_annotation stays
// commandless for now — no consuming UI exists, and a command nobody can
// exercise is untestable surface area.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { sha256Hex } from '../ids.js';
import { releaseContentIfUnreferenced } from './media.js';

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
function contentItemFor(ctx: HandlerCtx, bodyText: string, format: string): string {
  const mediaType = MEDIA_TYPE[format] ?? 'text/plain';
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
                 ELSE (SELECT count(*) FROM knowledge_notebook WHERE notebook_id = :notebook_id)
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
                     THEN NOT EXISTS(SELECT 1 FROM knowledge_note_placement WHERE note_id = :note_id)
                     ELSE EXISTS(SELECT 1 FROM knowledge_note_placement
                                  WHERE note_id = :note_id AND notebook_id = :notebook_id) END)
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

/** File a note at the end of a notebook (position = MAX+1 among siblings). */
function placeNote(ctx: HandlerCtx, noteId: string, notebookId: string): void {
  const placementId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO knowledge_note_placement (placement_id, note_id, notebook_id, position)
       VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM knowledge_note_placement WHERE notebook_id = ?))`,
    )
    .run(placementId, noteId, notebookId, notebookId);
  ctx.wrote('knowledge.note_placement', placementId);
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
      name: 'note_exists',
      sql: 'SELECT count(*) AS n FROM knowledge_note WHERE note_id = :note_id',
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
    .prepare('SELECT format FROM knowledge_note WHERE note_id = ?')
    .get(input.note_id) as { format: string } | undefined;
  if (!current) throw new Error('note vanished between check and execute');
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number)[] = [ctx.now];
  let contentId: string | undefined;
  if (input.body_text !== undefined) {
    // A body edit re-resolves the reference: new (or deduped) content item,
    // decoded with the format the note will have after this edit.
    contentId = contentItemFor(ctx, input.body_text, input.format ?? current.format);
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
      name: 'note_exists',
      sql: 'SELECT count(*) AS n FROM knowledge_note WHERE note_id = :note_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'notebook_exists_if_given',
      sql: `SELECT CASE WHEN :notebook_id IS NULL THEN 1
                 ELSE (SELECT count(*) FROM knowledge_notebook WHERE notebook_id = :notebook_id)
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
                 THEN NOT EXISTS(SELECT 1 FROM knowledge_note_placement WHERE note_id = :note_id)
                 ELSE (SELECT count(*) FROM knowledge_note_placement WHERE note_id = :note_id) = 1
                      AND EXISTS(SELECT 1 FROM knowledge_note_placement
                                  WHERE note_id = :note_id AND notebook_id = :notebook_id)
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
  ctx.db.prepare('DELETE FROM knowledge_note_placement WHERE note_id = ?').run(input.note_id);
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
                 ELSE (SELECT count(*) FROM knowledge_notebook WHERE notebook_id = :parent_notebook_id)
            END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'notebook_created',
      sql: 'SELECT count(*) AS n FROM knowledge_notebook WHERE notebook_id = :notebook_id',
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
      `INSERT INTO knowledge_notebook (notebook_id, owner_party_id, name, parent_notebook_id, sort_order)
       VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM knowledge_notebook
                             WHERE parent_notebook_id IS ?))`,
    )
    .run(
      notebookId,
      actorPartyId(ctx),
      input.name,
      input.parent_notebook_id ?? null,
      input.parent_notebook_id ?? null,
    );
  ctx.wrote('knowledge.notebook', notebookId);
  return { notebook_id: notebookId };
}

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
    required: ['note_id'],
    properties: {
      note_id: { type: 'string' },
      body_released: { type: 'integer' },
    },
  },
  preconditions: [
    {
      name: 'note_exists',
      sql: 'SELECT count(*) AS n FROM knowledge_note WHERE note_id = :note_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // The note and every edge onto it are gone together.
      name: 'note_and_edges_removed',
      sql: `SELECT (
              (SELECT count(*) FROM knowledge_note WHERE note_id = :note_id)
              + (SELECT count(*) FROM knowledge_note_placement WHERE note_id = :note_id)
              + (SELECT count(*) FROM core_attachment WHERE subject_type = 'knowledge.note' AND subject_id = :note_id)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: deleteNote,
};

function deleteNote(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { note_id: string };
  const note = ctx.db
    .prepare('SELECT body_content_id FROM knowledge_note WHERE note_id = ?')
    .get(input.note_id) as { body_content_id: string } | undefined;
  if (!note) throw new Error('note vanished between check and execute');
  ctx.db.prepare('DELETE FROM knowledge_note_placement WHERE note_id = ?').run(input.note_id);
  ctx.db
    .prepare(
      `DELETE FROM knowledge_annotation WHERE target_type = 'knowledge.note' AND target_id = ?`,
    )
    .run(input.note_id);
  ctx.db
    .prepare(`DELETE FROM core_attachment WHERE subject_type = 'knowledge.note' AND subject_id = ?`)
    .run(input.note_id);
  ctx.db.prepare('DELETE FROM knowledge_note WHERE note_id = ?').run(input.note_id);
  ctx.wrote('knowledge.note', input.note_id);
  // Bodies are sha256-deduped and canonical — another note or message may
  // still rent the same bytes, so only an unreferenced body soft-deletes.
  const released = releaseContentIfUnreferenced(ctx, note.body_content_id);
  ctx.cite({
    claim: `note ${input.note_id} deleted; body ${released ? 'soft-deleted' : 'still rented elsewhere'}`,
    entityType: 'knowledge.note',
    entityId: input.note_id,
  });
  return { note_id: input.note_id, body_released: released ? 1 : 0 };
}

/** Register the knowledge domain's commands on a gateway. */
export function registerKnowledgeCommands(gateway: Gateway): void {
  gateway.registerCommand(CREATE_NOTE);
  gateway.registerCommand(EDIT_NOTE);
  gateway.registerCommand(MOVE_NOTE);
  gateway.registerCommand(CREATE_NOTEBOOK);
  gateway.registerCommand(DELETE_NOTE);
}
