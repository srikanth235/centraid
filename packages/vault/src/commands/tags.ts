// Free-form multi-tag commands (issue #352 phase 3/4): core_tag is already
// UNIQUE(target_type, target_id, concept_id) — multi-tag capable — but every
// existing writer treats it as SINGLE-tag storage: documents.ts's `fileInto`
// deletes-then-inserts one folders-scheme tag, flags.ts's `setStarred` one
// flags-scheme tag. Neither gives an app a generic, ADDITIVE "put a label on
// this" gesture. These two commands are that gesture, over an owner "labels"
// concept scheme — bootstrapped on first use exactly like the folders and
// flags schemes (documents.ts / flags.ts), so a label is a first-class SKOS
// concept (findable, mergeable, renameable later) rather than a bare string
// column would be.
//
// Scoped to two target types today (documents, media assets) — the same
// polymorphic-ref discipline core.link_entities uses (validate the target
// resolves, exists, and is LIVE) without link_entities' fully generic reach:
// a free-form labeling surface open to every canonical table is more power
// than either app needs, and narrowing the allow-list keeps the risk surface
// tight. Widening to another target type is one entry in TAGGABLE_TARGETS.
//
// No new read path is needed: core.tag / core.concept / core.concept_scheme
// are already registered logical entities (schema/tables.ts), so an app with
// read scope on them lists an entity's labels with the same bounded-read
// pattern the photos app already uses for the flags-scheme star (see
// packages/blueprints/apps/photos/queries/library.js).

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';

// An https URI, not a urn: one — this literal is interpolated into condition
// SQL, where `:labels` would read as a named parameter (the issue-258
// colon-literal trap folders/flags both note).
export const LABELS_SCHEME_URI = 'https://centraid.dev/schemes/labels';

/** Polymorphic targets this command pack accepts, with their live-row test. */
const TAGGABLE_TARGETS: Record<string, { physical: string; pk: string }> = {
  'core.document': { physical: 'core_document', pk: 'document_id' },
  'media.media_asset': { physical: 'media_media_asset', pk: 'asset_id' },
};

const TARGET_LIVE_SQL = Object.entries(TAGGABLE_TARGETS)
  .map(
    ([type, t]) =>
      `(:target_type = '${type}' AND EXISTS(SELECT 1 FROM ${t.physical} WHERE ${t.pk} = :target_id AND deleted_at IS NULL))`,
  )
  .join('\n              OR ');

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

/** The labels scheme, created on first use. */
function labelsSchemeId(ctx: HandlerCtx): string {
  const existing = ctx.db
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(LABELS_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Labels', 'centraid', '1')`,
    )
    .run(schemeId, LABELS_SCHEME_URI);
  return schemeId;
}

/**
 * Find-or-create a label concept by text. Identity is the trimmed,
 * lowercased text (so "Beach" and "beach" collapse onto one concept, the
 * same free-form-tag semantics users expect); `pref_label` keeps whichever
 * casing was typed first.
 */
function findOrCreateLabelConcept(ctx: HandlerCtx, label: string): string {
  const notation = label.trim().toLowerCase();
  const schemeId = labelsSchemeId(ctx);
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

/** Condition fragment: `:label` resolves to a live tag on (target_type, target_id). */
const TAG_LIVE_SQL = `
  SELECT count(*) AS n FROM core_tag t
    JOIN core_concept c ON c.concept_id = t.concept_id
    JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
   WHERE t.target_type = :target_type AND t.target_id = :target_id
     AND s.uri = '${LABELS_SCHEME_URI}' AND c.notation = lower(trim(:label))`;

const TAG_ENTITY: CommandDefinition = {
  name: 'core.tag_entity',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['target_type', 'target_id', 'label'],
    additionalProperties: false,
    properties: {
      target_type: { type: 'string', enum: Object.keys(TAGGABLE_TARGETS) },
      target_id: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['tag_id', 'concept_id'],
    properties: { tag_id: { type: 'string' }, concept_id: { type: 'string' }, deduped: {} },
  },
  preconditions: [
    {
      name: 'label_not_blank',
      sql: `SELECT CASE WHEN trim(:label) != '' THEN 1 ELSE 0 END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      name: 'target_exists_live',
      sql: `SELECT (${TARGET_LIVE_SQL}) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [{ name: 'tag_live', sql: TAG_LIVE_SQL, column: 'n', op: 'eq', value: 1 }],
  idempotency: 'idempotent',
  risk: 'low',
  handler: tagEntity,
};

function tagEntity(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { target_type: string; target_id: string; label: string };
  const conceptId = findOrCreateLabelConcept(ctx, input.label);
  const existing = ctx.db
    .prepare(
      'SELECT tag_id FROM core_tag WHERE target_type = ? AND target_id = ? AND concept_id = ?',
    )
    .get(input.target_type, input.target_id, conceptId) as { tag_id: string } | undefined;
  if (existing) {
    return { tag_id: existing.tag_id, concept_id: conceptId, deduped: 1 };
  }
  const tagId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    )
    .run(tagId, input.target_type, input.target_id, conceptId, actorPartyId(ctx), ctx.now);
  ctx.wrote('core.tag', tagId);
  ctx.cite({
    claim: `${input.target_type} ${input.target_id} labeled "${input.label.trim()}"`,
    entityType: 'core.tag',
    entityId: tagId,
  });
  return { tag_id: tagId, concept_id: conceptId, deduped: 0 };
}

const UNTAG_ENTITY: CommandDefinition = {
  name: 'core.untag_entity',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['target_type', 'target_id', 'label'],
    additionalProperties: false,
    properties: {
      target_type: { type: 'string', enum: Object.keys(TAGGABLE_TARGETS) },
      target_id: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['target_type', 'target_id'],
    properties: { target_type: { type: 'string' }, target_id: { type: 'string' } },
  },
  preconditions: [{ name: 'tag_live', sql: TAG_LIVE_SQL, column: 'n', op: 'eq', value: 1 }],
  postconditions: [{ name: 'tag_gone', sql: TAG_LIVE_SQL, column: 'n', op: 'eq', value: 0 }],
  idempotency: 'idempotent',
  risk: 'low',
  handler: untagEntity,
};

function untagEntity(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { target_type: string; target_id: string; label: string };
  const notation = input.label.trim().toLowerCase();
  const row = ctx.db
    .prepare(
      `SELECT t.tag_id AS tag_id FROM core_tag t
         JOIN core_concept c ON c.concept_id = t.concept_id
         JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
        WHERE t.target_type = ? AND t.target_id = ? AND s.uri = ? AND c.notation = ?`,
    )
    .get(input.target_type, input.target_id, LABELS_SCHEME_URI, notation) as
    | { tag_id: string }
    | undefined;
  if (!row) throw new Error('tag vanished between check and execute');
  // Classification, not history (issue #274's same reasoning for flags): a
  // hard delete, not an end-dated row — nothing reads a dead label's history.
  ctx.db.prepare('DELETE FROM core_tag WHERE tag_id = ?').run(row.tag_id);
  ctx.wrote('core.tag', row.tag_id);
  ctx.cite({
    claim: `${input.target_type} ${input.target_id} label "${input.label.trim()}" removed`,
    entityType: 'core.tag',
    entityId: row.tag_id,
  });
  return { target_type: input.target_type, target_id: input.target_id };
}

/** Register the free-form tagging commands on a gateway. */
export function registerTagCommands(gateway: Gateway): void {
  gateway.registerCommand(TAG_ENTITY);
  gateway.registerCommand(UNTAG_ENTITY);
}
