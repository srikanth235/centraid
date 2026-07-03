// Core party commands (§03): the missing "new contact" path. Every projection
// that anchors on core_party — leads, people, studio — could until now only
// pick from parties that arrived by owner-side import (vCard, ICS) or
// bootstrap. add_party lets a consent-granted app mint the identity row
// itself, identifiers included, so "add a lead I met today" is one flow, not
// an import errand. Identifier binding reuses social.resolve_identity's
// invariant: a (scheme, value) pair claimed by a different party is an
// identity fork and is refused, never merged silently.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';

const IDENTIFIER_SCHEMES = ['email', 'tel', 'url', 'handle', 'other'] as const;

const ADD_PARTY: CommandDefinition = {
  name: 'core.add_party',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['display_name'],
    additionalProperties: false,
    properties: {
      display_name: { type: 'string', minLength: 1 },
      // Agents enroll through their own path (agent.agent); apps mint people
      // and the organisations/groups those people belong to.
      kind: { type: 'string', enum: ['person', 'org', 'group'] },
      sort_name: { type: 'string' },
      birth_date: { type: 'string' },
      identifiers: {
        type: 'array',
        items: {
          type: 'object',
          required: ['scheme', 'value'],
          additionalProperties: false,
          properties: {
            scheme: { type: 'string', enum: [...IDENTIFIER_SCHEMES] },
            value: { type: 'string', minLength: 1 },
            label: { type: 'string' },
          },
        },
      },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: {
      party_id: { type: 'string' },
      identifiers_bound: { type: 'integer' },
    },
  },
  // Identifier conflicts can't ride templated precondition SQL (array
  // input); the handler validates and throws, landing as a receipted deny.
  preconditions: [],
  postconditions: [
    {
      name: 'party_created',
      sql: 'SELECT count(*) AS n FROM core_party WHERE party_id = :party_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addParty,
};

function addParty(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    display_name: string;
    kind?: string;
    sort_name?: string;
    birth_date?: string;
    identifiers?: { scheme: string; value: string; label?: string }[];
  };
  const identifiers = input.identifiers ?? [];
  // An identifier already bound to any party is a fork, not a new contact —
  // surface who owns it so the app can offer that party instead.
  for (const id of identifiers) {
    const claimed = ctx.db
      .prepare(
        `SELECT i.party_id, p.display_name FROM core_party_identifier i
           JOIN core_party p ON p.party_id = i.party_id
          WHERE i.scheme = ? AND i.value = ?`,
      )
      .get(id.scheme, id.value) as { party_id: string; display_name: string } | undefined;
    if (claimed) {
      throw new Error(
        `${id.scheme}:${id.value} already identifies "${claimed.display_name}" (${claimed.party_id})`,
      );
    }
  }
  const partyId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      partyId,
      input.kind ?? 'person',
      input.display_name,
      input.sort_name ?? null,
      input.birth_date ?? null,
      ctx.now,
      ctx.now,
      ONTOLOGY_VERSION,
    );
  ctx.wrote('core.party', partyId);
  const seenSchemes = new Set<string>();
  for (const id of identifiers) {
    const identifierId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_party_identifier (identifier_id, party_id, scheme, value, label, is_primary, verified_at, valid_from, valid_to)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        identifierId,
        partyId,
        id.scheme,
        id.value,
        id.label ?? null,
        seenSchemes.has(id.scheme) ? 0 : 1,
        ctx.now,
      );
    seenSchemes.add(id.scheme);
    ctx.wrote('core.party_identifier', identifierId);
  }
  return { party_id: partyId, identifiers_bound: identifiers.length };
}

const UPDATE_PARTY: CommandDefinition = {
  name: 'core.update_party',
  ownerSchema: 'core',
  inputSchema: {
    type: 'object',
    required: ['party_id'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      display_name: { type: 'string', minLength: 1 },
      sort_name: { type: 'string' },
      birth_date: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [
    {
      // Agent identity rows are managed by enrollment, not by contact apps.
      name: 'party_exists_and_editable',
      sql: `SELECT count(*) AS n FROM core_party WHERE party_id = :party_id AND kind != 'agent'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Each field either wasn't asked for, or reads back exactly as sent.
      name: 'edits_applied',
      sql: `SELECT (
              (SELECT CASE WHEN :display_name IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM core_party WHERE party_id = :party_id AND display_name = :display_name) END)
              AND (SELECT CASE WHEN :sort_name IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM core_party WHERE party_id = :party_id AND sort_name = :sort_name) END)
              AND (SELECT CASE WHEN :birth_date IS NULL THEN 1
                           ELSE EXISTS(SELECT 1 FROM core_party WHERE party_id = :party_id AND birth_date = :birth_date) END)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: updateParty,
};

function updateParty(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    party_id: string;
    display_name?: string;
    sort_name?: string;
    birth_date?: string;
  };
  const sets: string[] = [];
  const values: string[] = [];
  if (input.display_name !== undefined) {
    sets.push('display_name = ?');
    values.push(input.display_name);
  }
  if (input.sort_name !== undefined) {
    sets.push('sort_name = ?');
    values.push(input.sort_name);
  }
  if (input.birth_date !== undefined) {
    sets.push('birth_date = ?');
    values.push(input.birth_date);
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    values.push(ctx.now);
    ctx.db
      .prepare(`UPDATE core_party SET ${sets.join(', ')} WHERE party_id = ?`)
      .run(...values, input.party_id);
  }
  ctx.wrote('core.party', input.party_id);
  ctx.cite({
    claim: `party ${input.party_id} details revised${input.display_name ? ` → "${input.display_name}"` : ''}`,
    entityType: 'core.party',
    entityId: input.party_id,
  });
  return { party_id: input.party_id };
}

/** Register the core party commands on a gateway. */
export function registerPartyCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_PARTY);
  gateway.registerCommand(UPDATE_PARTY);
}
