// Links (core §01/§08, issue #272): the typed, temporal relationship fabric,
// activated as commands. All cross-entity meaning goes through core.link — a
// SKOS-governed relation concept, valid_from/valid_to, who asserted it —
// never an ad-hoc junction table. These two commands are the whole write
// surface: any app or agent gets universal cross-referencing by declaring
// one act scope, and backlinks come free as a reverse read of the same
// table. Unlink is temporal, not destructive: history is never rewritten
// (rule R3); the gateway's dangling-link sweep end-dates the rest.

import type { Gateway } from '../gateway/gateway.js';
import { evaluateConsent } from '../gateway/consent.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { resolveEntity } from '../schema/tables.js';

/** The SKOS scheme link relations come from (seeded at bootstrap + v3). */
export const RELATIONS_SCHEME_URI = 'urn:duaility:relations';

// Condition SQL treats `:word` as a named parameter even inside string
// literals (the issue-258 colon-literal trap), so the urn is assembled with
// char(58) when it appears in a precondition.
const RELATIONS_SCHEME_URI_SQL = RELATIONS_SCHEME_URI.split(':')
  .map((part) => `'${part}'`)
  .join(' || char(58) || ');

function pkOf(ctx: HandlerCtx, physical: string): string {
  const rows = ctx.db.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
    name: string;
    pk: number;
  }[];
  const pk = rows.find((r) => r.pk === 1)?.name;
  if (!pk) throw new Error(`no primary key on ${physical}`);
  return pk;
}

/**
 * An endpoint must resolve in the entity registry, exist as a live row, and
 * be READABLE under the caller's grant and purpose — a caller must never
 * assert a relationship to a row it is not allowed to see. The shell picker
 * satisfies this trivially (the owner reads everything); apps satisfy it
 * exactly when their scopes already cover both sides.
 */
function requireEndpoint(ctx: HandlerCtx, role: 'from' | 'to', type: string, id: string): void {
  const ref = resolveEntity(type);
  if (!ref || ref.file !== 'vault') {
    throw new Error(`${role}_type names unknown entity "${type}"`);
  }
  if (ref.schema === 'core' && (ref.table === 'link' || ref.table === 'link_anchor')) {
    throw new Error('links do not link links');
  }
  const pk = pkOf(ctx, ref.physical);
  const live = ctx.db.prepare(`SELECT 1 AS x FROM "${ref.physical}" WHERE "${pk}" = ?`).get(id);
  if (!live) throw new Error(`no ${type} with id ${id}`);
  const consent = evaluateConsent(ctx.db, ctx.identity, ref.schema, ref.table, 'read', ctx.purpose);
  if (consent.decision === 'deny') {
    throw new Error(`grant does not cover read of ${type}: ${consent.failing}`);
  }
}

// The standoff anchor selector (issue #282): a W3C-style text-quote selector
// plus a position hint, pointing into the from-endpoint's decoded body text.
// `start` is a char offset in UTF-16 code units (the JS-string convention the
// projections decode to). The anchor is a locator for the link, never a
// second judgment — resolution is presentation-side and best-effort.
const SELECTOR_SCHEMA = {
  type: 'object',
  required: ['exact', 'prefix', 'suffix', 'start'],
  additionalProperties: false,
  properties: {
    exact: { type: 'string', minLength: 1 },
    prefix: { type: 'string' },
    suffix: { type: 'string' },
    start: { type: 'integer', minimum: 0 },
  },
} as const;

interface AnchorSelector {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
}

/** Upsert the one anchor a link may carry; returns the anchor row id. */
function writeAnchor(ctx: HandlerCtx, linkId: string, selector: AnchorSelector): string {
  const existing = ctx.db
    .prepare('SELECT anchor_id FROM core_link_anchor WHERE link_id = ?')
    .get(linkId) as { anchor_id: string } | undefined;
  const json = JSON.stringify({
    exact: selector.exact,
    prefix: selector.prefix,
    suffix: selector.suffix,
    start: selector.start,
  });
  if (existing) {
    ctx.db
      .prepare('UPDATE core_link_anchor SET selector_json = ? WHERE anchor_id = ?')
      .run(json, existing.anchor_id);
    return existing.anchor_id;
  }
  const anchorId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_link_anchor (anchor_id, link_id, selector_json, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(anchorId, linkId, json, ctx.now);
  return anchorId;
}

const LINK: CommandDefinition = {
  name: 'core.link_entities',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['from_type', 'from_id', 'to_type', 'to_id', 'relation'],
    additionalProperties: false,
    properties: {
      from_type: { type: 'string', minLength: 1 },
      from_id: { type: 'string', minLength: 1 },
      to_type: { type: 'string', minLength: 1 },
      to_id: { type: 'string', minLength: 1 },
      /** Notation into the relations scheme, e.g. `references`, `about`. */
      relation: { type: 'string', minLength: 1 },
      /** Optional inline anchor written atomically with the link (issue #282). */
      selector: SELECTOR_SCHEMA,
    },
  },
  outputSchema: {
    type: 'object',
    required: ['link_id'],
    properties: {
      link_id: { type: 'string' },
      relation_concept_id: { type: 'string' },
    },
  },
  preconditions: [
    {
      // Relations are vocabulary, never caller-invented: the notation must
      // already be a concept in the relations scheme.
      name: 'relation_in_scheme',
      sql: `SELECT count(*) AS n FROM core_concept c
             JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
            WHERE s.uri = ${RELATIONS_SCHEME_URI_SQL} AND c.notation = :relation`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Refuse an exact duplicate while the first assertion is still live;
      // after an unlink the same relationship may be asserted again.
      name: 'no_identical_live_link',
      sql: `SELECT count(*) AS n FROM core_link l
             JOIN core_concept c ON c.concept_id = l.relation_concept_id
            WHERE l.from_type = :from_type AND l.from_id = :from_id
              AND l.to_type = :to_type AND l.to_id = :to_id
              AND c.notation = :relation AND l.valid_to IS NULL`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'link_live',
      sql: 'SELECT count(*) AS n FROM core_link WHERE link_id = :link_id AND valid_to IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: linkEntities,
};

function linkEntities(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    from_type: string;
    from_id: string;
    to_type: string;
    to_id: string;
    relation: string;
    selector?: AnchorSelector;
  };
  if (input.from_type === input.to_type && input.from_id === input.to_id) {
    throw new Error('an entity cannot link to itself');
  }
  requireEndpoint(ctx, 'from', input.from_type, input.from_id);
  requireEndpoint(ctx, 'to', input.to_type, input.to_id);
  const relation = ctx.db
    .prepare(
      `SELECT c.concept_id FROM core_concept c
        JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
       WHERE s.uri = ? AND c.notation = ?`,
    )
    .get(RELATIONS_SCHEME_URI, input.relation) as { concept_id: string } | undefined;
  if (!relation) throw new Error(`unknown relation "${input.relation}"`);
  const assertedBy =
    ctx.identity.kind === 'app' ? 'app' : ctx.identity.kind === 'agent' ? 'agent' : 'owner';
  const linkId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_link
         (link_id, from_type, from_id, to_type, to_id, relation_concept_id, valid_from, valid_to, asserted_by, provenance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(
      linkId,
      input.from_type,
      input.from_id,
      input.to_type,
      input.to_id,
      relation.concept_id,
      ctx.now,
      assertedBy,
    );
  ctx.wrote('core.link', linkId);
  if (input.selector) {
    const anchorId = writeAnchor(ctx, linkId, input.selector);
    ctx.wrote('core.link_anchor', anchorId);
  }
  ctx.cite({
    claim: `${input.from_type} ${input.from_id} —${input.relation}→ ${input.to_type} ${input.to_id}`,
    entityType: 'core.link',
    entityId: linkId,
  });
  return { link_id: linkId, relation_concept_id: relation.concept_id };
}

const UNLINK: CommandDefinition = {
  name: 'core.unlink_entities',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['link_id'],
    additionalProperties: false,
    properties: { link_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['link_id'],
    properties: { link_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'link_live',
      sql: 'SELECT count(*) AS n FROM core_link WHERE link_id = :link_id AND valid_to IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Ended, not erased: the row survives with valid_to set (rule R3).
      name: 'link_ended',
      sql: `SELECT count(*) AS n FROM core_link
             WHERE link_id = :link_id AND valid_to IS NOT NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: unlinkEntities,
};

function unlinkEntities(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { link_id: string };
  ctx.db.prepare('UPDATE core_link SET valid_to = ? WHERE link_id = ?').run(ctx.now, input.link_id);
  ctx.wrote('core.link', input.link_id);
  return { link_id: input.link_id };
}

// Re-anchor / re-baseline (issue #282): move (or clear) the standoff anchor
// an existing live link carries. This is a locator write, not a new judgment
// — the link's endpoints, relation and validity are untouched. With a
// selector it upserts the anchor (the @-gesture re-anchoring an orphaned
// edge, or the editor re-baselining after a save); without one it clears the
// anchor, demoting the reference to strip-only — which also makes it exempt
// from the editor's orphan auto-retract by construction.
const ANCHOR: CommandDefinition = {
  name: 'core.anchor_link',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['link_id'],
    additionalProperties: false,
    properties: {
      link_id: { type: 'string', minLength: 1 },
      selector: SELECTOR_SCHEMA,
    },
  },
  outputSchema: {
    type: 'object',
    required: ['link_id'],
    properties: {
      link_id: { type: 'string' },
      anchor_id: { type: 'string' },
    },
  },
  preconditions: [
    {
      // Anchors ride live judgments only — an ended link keeps its history
      // but takes no new locator.
      name: 'link_live',
      sql: 'SELECT count(*) AS n FROM core_link WHERE link_id = :link_id AND valid_to IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'link_still_live',
      sql: 'SELECT count(*) AS n FROM core_link WHERE link_id = :link_id AND valid_to IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: anchorLink,
};

function anchorLink(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { link_id: string; selector?: AnchorSelector };
  if (input.selector) {
    const anchorId = writeAnchor(ctx, input.link_id, input.selector);
    ctx.wrote('core.link_anchor', anchorId);
    return { link_id: input.link_id, anchor_id: anchorId };
  }
  const existing = ctx.db
    .prepare('SELECT anchor_id FROM core_link_anchor WHERE link_id = ?')
    .get(input.link_id) as { anchor_id: string } | undefined;
  if (existing) {
    // A locator is presentation, not history — clearing it is a hard delete.
    ctx.db.prepare('DELETE FROM core_link_anchor WHERE anchor_id = ?').run(existing.anchor_id);
    ctx.wrote('core.link_anchor', existing.anchor_id);
  }
  return { link_id: input.link_id };
}

/** Register the core link commands on a gateway. */
export function registerLinkCommands(gateway: Gateway): void {
  gateway.registerCommand(LINK);
  gateway.registerCommand(UNLINK);
  gateway.registerCommand(ANCHOR);
}
