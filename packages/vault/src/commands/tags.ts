// Generic tagging (core §01, issue #274's "folders-scheme tags" comment):
// owner-driven, free-form labels on top of the same SKOS mechanism the
// enrichment pipeline uses for classification (core_concept /
// core_concept_scheme) and core_tag itself. Distinct from core.collection
// (an ordered, owner-curated container — "Paris trip" holding specific
// items) and from social.circle (an audience) — a tag is neither ordered
// nor a container, just a cross-cutting label a projection can filter by.
//
// One well-known scheme per vault, `centraid:tags:v1`, found by its unique
// `uri` rather than a hardcoded id — every projection that tags anything
// shares the same scheme, same posture as attachments sharing one
// core_content_item pool. Issue #352 widened the original task/note-only
// reach to documents and media assets — same mechanism, no new table, no
// second scheme: exactly the "one judgment, one mechanism" rule a `favorite`
// column or a parallel tags table would have violated.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';

const TAGS_SCHEME_URI = 'centraid:tags:v1';

/**
 * The entities a projection may tag: logical name → primary-key column,
 * plus whether the table has a `deleted_at` lifecycle to respect (tasks
 * don't soft-delete; notes/documents/media assets do). Same allow-list
 * posture as attachments.ts's SUBJECT_PK: the physical table is the logical
 * name with the dot underscored, so this doubles as a guard against an
 * unknown subject_type ever reaching raw SQL.
 */
const SUBJECT_PK: Record<string, { pk: string; live?: boolean }> = {
  'knowledge.note': { pk: 'note_id', live: true },
  'schedule.task': { pk: 'task_id' },
  'core.document': { pk: 'document_id', live: true },
  'media.media_asset': { pk: 'asset_id', live: true },
};

/** A tag's display label → its notation: lowercased, collapsed whitespace, trimmed. */
function notationOf(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

function findOrCreateTagsScheme(ctx: HandlerCtx): string {
  const existing = ctx.db
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(TAGS_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Tags', 'centraid', 'v1')`,
    )
    .run(schemeId, TAGS_SCHEME_URI);
  return schemeId;
}

function findOrCreateConcept(ctx: HandlerCtx, schemeId: string, label: string): string {
  const notation = notationOf(label);
  const existing = ctx.db
    .prepare('SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?')
    .get(schemeId, notation) as { concept_id: string } | undefined;
  if (existing) return existing.concept_id;
  const conceptId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .run(conceptId, schemeId, notation, label.trim());
  return conceptId;
}

const TAG_ITEM: CommandDefinition = {
  name: 'core.tag_item',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['subject_type', 'subject_id', 'label'],
    additionalProperties: false,
    properties: {
      subject_type: { type: 'string', enum: Object.keys(SUBJECT_PK) },
      subject_id: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['tag_id', 'concept_id', 'notation'],
    properties: {
      tag_id: { type: 'string' },
      concept_id: { type: 'string' },
      notation: { type: 'string' },
    },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'tag_recorded',
      sql: `SELECT count(*) AS n FROM core_tag
             WHERE tag_id = :tag_id AND target_type = :subject_type AND target_id = :subject_id
               AND concept_id = :concept_id`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: tagItem,
};

function tagItem(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { subject_type: string; subject_id: string; label: string };
  const subject = SUBJECT_PK[input.subject_type];
  if (!subject) throw new Error(`cannot tag ${input.subject_type}`);
  const table = input.subject_type.replace('.', '_');
  const liveClause = subject.live ? ' AND deleted_at IS NULL' : '';
  const found = ctx.db
    .prepare(`SELECT count(*) AS n FROM ${table} WHERE ${subject.pk} = ?${liveClause}`)
    .get(input.subject_id) as { n: number };
  if (found.n !== 1) throw new Error(`no live ${input.subject_type} with id ${input.subject_id}`);
  const notation = notationOf(input.label);
  if (!notation) throw new Error('tag label is empty');

  const schemeId = findOrCreateTagsScheme(ctx);
  const conceptId = findOrCreateConcept(ctx, schemeId, input.label);

  // Idempotent: retagging with the same label just returns the existing
  // edge (core_tag's UNIQUE(target_type, target_id, concept_id) — the same
  // "attach again, no duplicate" posture as core.attach's dedup).
  const existingTag = ctx.db
    .prepare(
      'SELECT tag_id FROM core_tag WHERE target_type = ? AND target_id = ? AND concept_id = ?',
    )
    .get(input.subject_type, input.subject_id, conceptId) as { tag_id: string } | undefined;
  if (existingTag) {
    return { tag_id: existingTag.tag_id, concept_id: conceptId, notation };
  }

  // Owner-asserted: a party, no confidence — the exact inverse of an
  // enrichment-derived tag (confidence, no party), per the derived-data
  // contract enrich-publishers.ts documents.
  const tagId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(tagId, input.subject_type, input.subject_id, conceptId, actorPartyId(ctx), ctx.now);
  ctx.wrote('core.tag', tagId);
  ctx.cite({
    claim: `tagged ${input.subject_type} ${input.subject_id} "${notation}"`,
    entityType: input.subject_type,
    entityId: input.subject_id,
  });
  return { tag_id: tagId, concept_id: conceptId, notation };
}

const UNTAG_ITEM: CommandDefinition = {
  name: 'core.untag_item',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['tag_id'],
    additionalProperties: false,
    properties: { tag_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['tag_id'],
    properties: { tag_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'tag_exists',
      sql: 'SELECT count(*) AS n FROM core_tag WHERE tag_id = :tag_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'tag_removed',
      sql: 'SELECT count(*) AS n FROM core_tag WHERE tag_id = :tag_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: untagItem,
};

function untagItem(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { tag_id: string };
  ctx.db.prepare('DELETE FROM core_tag WHERE tag_id = ?').run(input.tag_id);
  ctx.wrote('core.tag', input.tag_id);
  return { tag_id: input.tag_id };
}

/** Register the core tagging commands on a gateway. */
export function registerTagCommands(gateway: Gateway): void {
  gateway.registerCommand(TAG_ITEM);
  gateway.registerCommand(UNTAG_ITEM);
}

/** The subject types a projection may tag — exported for callers/tests. */
export const TAGGABLE_SUBJECTS = Object.keys(SUBJECT_PK);
