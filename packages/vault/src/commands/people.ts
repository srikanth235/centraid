// governance: allow-repo-hygiene file-size-limit one command pack per domain is the vault contract (registered as a unit, read wholesale); People owns the whole keep-in-touch loop — persons, lists, interactions, tasks, dates, relationships, gifts, debts and the journal — so it is large by design.
// People commands (schema `people`): the personal-CRM write surface. A person
// is a canonical core.party (kind='person') plus a 1:1 people_profile holding
// the keep-in-touch facts — role, avatar hue, cadence, last-contacted, how you
// met. add_person mints the party and profile in one stroke; everything else
// hangs off the party id.
//
// The gestures the ontology already models are reused, not re-invented (issue
// #274): notes are knowledge.annotation on the party (annotate), favorites are
// the flags-scheme star on the party (setStarred), and the owner files people
// into `lists` — SKOS concepts in the owner's `lists` scheme with membership
// one core.tag per person, the same mechanism Docs folders use. These were
// named "circles" until issue #441 A2.4 found the name collided with
// social_circle (the AUDIENCE mechanism shares and Tally groups target); the
// classification is renamed to "lists" end-to-end, social_circle keeps its
// "circle" name. Logging an interaction is what clears "overdue": it stamps
// profile.last_contacted_at = now. Every write is a typed command —
// consent-checked, receipted, all risk low.

import type { Gateway } from '../gateway/gateway.js';
import type { CommandDefinition, HandlerCtx } from '../gateway/types.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import { cleanupPolyRefs } from '../schema/poly-refs.js';
import { annotate } from './annotations.js';
import { setStarred, starredExistsSql } from './flags.js';
import { contentItemFor } from './knowledge.js';
import { RELATIONS_SCHEME_URI, RELATIONS_SCHEME_URI_SQL } from './links.js';

// An https URI, not a urn: one — this literal interpolates into condition SQL,
// where `:lists` would read as a named parameter (the issue-258 colon-literal
// trap); `https://` survives because no parameter name starts with a slash.
export const LIST_SCHEME_URI = 'https://centraid.dev/schemes/lists';
const ACTIVITY_KIND_SCHEME_URI = 'urn:duaility:activity-kinds';
const JOURNAL_SCHEME_URI = 'https://centraid.dev/schemes/people-journal';

/** The acting party: the caller's own party, else the vault owner (apps). */
function actorPartyId(ctx: HandlerCtx): string {
  if (ctx.identity.partyId) return ctx.identity.partyId;
  return ownerPartyId(ctx);
}

/** The vault owner's party id. */
function ownerPartyId(ctx: HandlerCtx): string {
  const owner = ctx.db.prepare('SELECT owner_party_id FROM core_vault LIMIT 1').get() as
    | { owner_party_id: string | null }
    | undefined;
  if (!owner?.owner_party_id) throw new Error('vault has no owner');
  return owner.owner_party_id;
}

/** The vault's base currency, for debts stored as minor units. */
function baseCurrency(ctx: HandlerCtx): string {
  const row = ctx.db.prepare('SELECT base_currency FROM core_vault LIMIT 1').get() as
    | { base_currency: string }
    | undefined;
  return row?.base_currency ?? 'USD';
}

/** The lists scheme, created on first use (mirrors the folders scheme). */
function listSchemeId(ctx: HandlerCtx): string {
  const existing = ctx.db
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(LIST_SCHEME_URI) as { scheme_id: string } | undefined;
  if (existing) return existing.scheme_id;
  const schemeId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
       VALUES (?, ?, 'Lists', 'centraid', '1')`,
    )
    .run(schemeId, LIST_SCHEME_URI);
  return schemeId;
}

/** File a person into exactly one list (or none): one lists-scheme tag. */
function fileIntoList(ctx: HandlerCtx, partyId: string, listConceptId: string | null): void {
  ctx.db
    .prepare(
      `DELETE FROM core_tag
        WHERE target_type = 'core.party' AND target_id = ?
          AND concept_id IN (SELECT c.concept_id FROM core_concept c
                               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                              WHERE s.uri = ?)`,
    )
    .run(partyId, LIST_SCHEME_URI);
  if (listConceptId == null) return;
  const tagId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_tag (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
       VALUES (?, 'core.party', ?, ?, ?, NULL, ?)`,
    )
    .run(tagId, partyId, listConceptId, actorPartyId(ctx), ctx.now);
  ctx.wrote('core.tag', tagId);
}

/** Resolve or mint one controlled-vocabulary concept used by a People gesture. */
function conceptId(
  ctx: HandlerCtx,
  schemeUri: string,
  schemeTitle: string,
  notation: string,
  label: string,
): string {
  let scheme = ctx.db
    .prepare('SELECT scheme_id FROM core_concept_scheme WHERE uri = ?')
    .get(schemeUri) as { scheme_id: string } | undefined;
  if (!scheme) {
    scheme = { scheme_id: ctx.newId() };
    ctx.db
      .prepare(
        `INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version)
         VALUES (?, ?, ?, 'centraid', '1')`,
      )
      .run(scheme.scheme_id, schemeUri, schemeTitle);
  }
  const existing = ctx.db
    .prepare('SELECT concept_id FROM core_concept WHERE scheme_id = ? AND notation = ?')
    .get(scheme.scheme_id, notation) as { concept_id: string } | undefined;
  if (existing) return existing.concept_id;
  const id = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_concept
         (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
    )
    .run(id, scheme.scheme_id, notation, label);
  ctx.wrote('core.concept', id);
  return id;
}

function assertedBy(ctx: HandlerCtx): 'owner' | 'app' | 'agent' {
  return ctx.identity.kind === 'app' ? 'app' : ctx.identity.kind === 'agent' ? 'agent' : 'owner';
}

/** Assert one temporal core.link and return its id. */
function linkToParty(
  ctx: HandlerCtx,
  fromType: string,
  fromId: string,
  partyId: string,
  relationConceptId: string,
): string {
  const linkId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_link
         (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
          valid_from, valid_to, asserted_by, provenance_id)
       VALUES (?, ?, ?, 'core.party', ?, ?, ?, NULL, ?, NULL)`,
    )
    .run(linkId, fromType, fromId, partyId, relationConceptId, ctx.now, assertedBy(ctx));
  ctx.wrote('core.link', linkId);
  return linkId;
}

function slug(text: string): string {
  return (
    text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'related'
  );
}

// Condition fragment: the id is a CRM person (a person party with a profile).
const PERSON_EXISTS_SQL = `
  SELECT count(*) AS n FROM people_profile pr
    JOIN core_party p ON p.party_id = pr.party_id
   WHERE pr.party_id = :party_id AND p.kind = 'person'`;

// Condition fragment: :list_id is a live concept in the lists scheme.
const LIST_EXISTS_SQL = `
  EXISTS(SELECT 1 FROM core_concept c
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE c.concept_id = :list_id AND s.uri = '${LIST_SCHEME_URI}')`;

// ---------- Person ----------

const ADD_PERSON: CommandDefinition = {
  name: 'people.add_person',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['display_name', 'cadence_days'],
    additionalProperties: false,
    properties: {
      display_name: { type: 'string', minLength: 1 },
      role: { type: 'string' },
      avatar_color: { type: 'string' },
      cadence_days: { type: 'integer', minimum: 1 },
      list_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'list_exists_if_given',
      sql: `SELECT CASE WHEN :list_id IS NULL THEN 1 ELSE ${LIST_EXISTS_SQL} END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'person_created',
      sql: 'SELECT count(*) AS n FROM people_profile WHERE party_id = :party_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: addPerson,
};

function addPerson(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    display_name: string;
    role?: string;
    avatar_color?: string;
    cadence_days: number;
    list_id?: string;
  };
  const partyId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, sort_name, birth_date, avatar_content_id, created_at, updated_at, ontology_version)
       VALUES (?, 'person', ?, NULL, NULL, NULL, ?, ?, ?)`,
    )
    .run(partyId, input.display_name, ctx.now, ctx.now, ONTOLOGY_VERSION);
  ctx.wrote('core.party', partyId);
  const profileId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO people_profile (profile_id, party_id, role, avatar_color, cadence_days, last_contacted_at, met, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(
      profileId,
      partyId,
      input.role ?? null,
      input.avatar_color ?? null,
      input.cadence_days,
      ctx.now,
    );
  ctx.wrote('people.profile', profileId);
  if (input.list_id != null) fileIntoList(ctx, partyId, input.list_id);
  ctx.cite({
    claim: `"${input.display_name}" added to People`,
    entityType: 'core.party',
    entityId: partyId,
  });
  return { party_id: partyId };
}

const EDIT_PERSON: CommandDefinition = {
  name: 'people.edit_person',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      display_name: { type: 'string', minLength: 1 },
      role: { type: 'string' },
      avatar_color: { type: 'string' },
      met: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'name_applied',
      sql: `SELECT CASE WHEN :display_name IS NULL THEN 1
               ELSE EXISTS(SELECT 1 FROM core_party WHERE party_id = :party_id AND display_name = :display_name) END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: editPerson,
};

function editPerson(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as {
    party_id: string;
    display_name?: string;
    role?: string;
    avatar_color?: string;
    met?: string;
  };
  if (input.display_name !== undefined) {
    ctx.db
      .prepare('UPDATE core_party SET display_name = ?, updated_at = ? WHERE party_id = ?')
      .run(input.display_name, ctx.now, input.party_id);
    ctx.wrote('core.party', input.party_id);
  }
  const sets: string[] = [];
  const values: (string | null)[] = [];
  if (input.role !== undefined) {
    sets.push('role = ?');
    values.push(input.role);
  }
  if (input.avatar_color !== undefined) {
    sets.push('avatar_color = ?');
    values.push(input.avatar_color);
  }
  if (input.met !== undefined) {
    sets.push('met = ?');
    values.push(input.met);
  }
  if (sets.length > 0) {
    ctx.db
      .prepare(`UPDATE people_profile SET ${sets.join(', ')} WHERE party_id = ?`)
      .run(...values, input.party_id);
    const profile = ctx.db
      .prepare('SELECT profile_id FROM people_profile WHERE party_id = ?')
      .get(input.party_id) as { profile_id: string } | undefined;
    if (profile) ctx.wrote('people.profile', profile.profile_id);
  }
  return { party_id: input.party_id };
}

const SET_CADENCE: CommandDefinition = {
  name: 'people.set_cadence',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'cadence_days'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      cadence_days: { type: 'integer', minimum: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'cadence_applied',
      sql: 'SELECT count(*) AS n FROM people_profile WHERE party_id = :party_id AND cadence_days = :cadence_days',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { party_id: string; cadence_days: number };
    ctx.db
      .prepare('UPDATE people_profile SET cadence_days = ? WHERE party_id = ?')
      .run(input.cadence_days, input.party_id);
    const profile = ctx.db
      .prepare('SELECT profile_id FROM people_profile WHERE party_id = ?')
      .get(input.party_id) as { profile_id: string } | undefined;
    if (profile) ctx.wrote('people.profile', profile.profile_id);
    return { party_id: input.party_id };
  },
};

const LOG_INTERACTION: CommandDefinition = {
  name: 'people.log_interaction',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'kind'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      kind: { type: 'string', minLength: 1 },
      text: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['interaction_id'],
    properties: { interaction_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      // Logged and last-contacted stamped in one stroke — this is what clears
      // "overdue".
      name: 'interaction_logged',
      sql: `SELECT (
              EXISTS(SELECT 1 FROM core_activity WHERE activity_id = :interaction_id)
              AND EXISTS(SELECT 1 FROM core_link
                           WHERE from_type = 'core.activity' AND from_id = :interaction_id
                             AND to_type = 'core.party' AND to_id = :party_id
                             AND valid_to IS NULL)
              AND EXISTS(SELECT 1 FROM people_profile WHERE party_id = :party_id AND last_contacted_at IS NOT NULL)
            ) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: logInteraction,
};

function logInteraction(ctx: HandlerCtx): Record<string, unknown> {
  const input = ctx.input as { party_id: string; kind: string; text?: string };
  const interactionId = ctx.newId();
  const kindConceptId = conceptId(
    ctx,
    ACTIVITY_KIND_SCHEME_URI,
    'Activity kinds',
    slug(input.kind),
    input.kind,
  );
  ctx.db
    .prepare(
      `INSERT INTO core_activity
         (activity_id, actor_party_id, kind_concept_id, started_at, ended_at,
          location_place_id, source_app_id, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?)`,
    )
    .run(interactionId, ownerPartyId(ctx), kindConceptId, ctx.now, ctx.now);
  ctx.wrote('core.activity', interactionId);
  const about = conceptId(ctx, RELATIONS_SCHEME_URI, 'Link relation types', 'about', 'About');
  linkToParty(ctx, 'core.activity', interactionId, input.party_id, about);
  if (input.text) annotate(ctx, 'core.activity', interactionId, input.text);
  ctx.db
    .prepare('UPDATE people_profile SET last_contacted_at = ? WHERE party_id = ?')
    .run(ctx.now, input.party_id);
  ctx.cite({
    claim: `logged a ${input.kind.toLowerCase()} with ${input.party_id}`,
    entityType: 'core.party',
    entityId: input.party_id,
  });
  return { interaction_id: interactionId };
}

// ---------- Favorite (the canonical flags-scheme star, on the party) ----------

const STAR_PERSON: CommandDefinition = {
  name: 'people.star_person',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id'],
    additionalProperties: false,
    properties: { party_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'person_starred',
      sql: `SELECT ${starredExistsSql('core.party', ':party_id')} AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { party_id: string };
    setStarred(ctx, 'core.party', input.party_id, true);
    ctx.wrote('core.party', input.party_id);
    return { party_id: input.party_id };
  },
};

const UNSTAR_PERSON: CommandDefinition = {
  name: 'people.unstar_person',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id'],
    additionalProperties: false,
    properties: { party_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'person_unstarred',
      sql: `SELECT ${starredExistsSql('core.party', ':party_id')} AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { party_id: string };
    setStarred(ctx, 'core.party', input.party_id, false);
    ctx.wrote('core.party', input.party_id);
    return { party_id: input.party_id };
  },
};

const MOVE_PERSON: CommandDefinition = {
  name: 'people.move_person',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      // Omitted list_id un-lists the person (back to no list).
      list_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
    {
      name: 'list_exists_if_given',
      sql: `SELECT CASE WHEN :list_id IS NULL THEN 1 ELSE ${LIST_EXISTS_SQL} END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      // Filed exactly where asked (=1 when correct): unfiled ⇒ no
      // lists-scheme tag; filed ⇒ the given list, and only it.
      name: 'list_applied',
      sql: `SELECT CASE WHEN :list_id IS NULL
               THEN (SELECT count(*) FROM core_tag t
                       JOIN core_concept c ON c.concept_id = t.concept_id
                       JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                      WHERE t.target_type = 'core.party' AND t.target_id = :party_id
                        AND s.uri = '${LIST_SCHEME_URI}') = 0
               ELSE ((SELECT count(*) FROM core_tag
                        WHERE target_type = 'core.party' AND target_id = :party_id
                          AND concept_id = :list_id) = 1
                     AND (SELECT count(*) FROM core_tag t
                            JOIN core_concept c ON c.concept_id = t.concept_id
                            JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                           WHERE t.target_type = 'core.party' AND t.target_id = :party_id
                             AND s.uri = '${LIST_SCHEME_URI}') = 1)
             END AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { party_id: string; list_id?: string };
    fileIntoList(ctx, input.party_id, input.list_id ?? null);
    ctx.wrote('core.party', input.party_id);
    return { party_id: input.party_id };
  },
};

// ---------- Notes (knowledge.annotation on the party) ----------

const ADD_NOTE: CommandDefinition = {
  name: 'people.add_note',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'text'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['party_id'],
    properties: { party_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { party_id: string; text: string };
    annotate(ctx, 'core.party', input.party_id, input.text);
    return { party_id: input.party_id };
  },
};

// ---------- Tasks ----------

const ADD_TASK: CommandDefinition = {
  name: 'people.add_task',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'text'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['task_id'],
    properties: { task_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'task_added',
      sql: `SELECT count(*) AS n FROM schedule_task t
             JOIN core_link l ON l.from_type = 'schedule.task' AND l.from_id = t.task_id
            WHERE t.task_id = :task_id AND l.to_type = 'core.party'
              AND l.to_id = :party_id AND l.valid_to IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { party_id: string; text: string };
    const taskId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO schedule_task
           (task_id, owner_party_id, title, description, status, priority, due_at,
            completed_at, effort_min, parent_task_id, rrule, remind_before_min)
         VALUES (?, ?, ?, NULL, 'needs-action', 0, NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(taskId, ownerPartyId(ctx), input.text);
    ctx.wrote('schedule.task', taskId);
    const about = conceptId(ctx, RELATIONS_SCHEME_URI, 'Link relation types', 'about', 'About');
    linkToParty(ctx, 'schedule.task', taskId, input.party_id, about);
    return { task_id: taskId };
  },
};

const TOGGLE_TASK: CommandDefinition = {
  name: 'people.toggle_task',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['task_id'],
    additionalProperties: false,
    properties: { task_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['task_id'],
    properties: { task_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'task_exists',
      sql: `SELECT count(*) AS n FROM schedule_task t
             JOIN core_link l ON l.from_type = 'schedule.task' AND l.from_id = t.task_id
             JOIN people_profile p ON p.party_id = l.to_id
            WHERE t.task_id = :task_id AND l.to_type = 'core.party' AND l.valid_to IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { task_id: string };
    ctx.db
      .prepare(
        `UPDATE schedule_task
            SET status = CASE status
              WHEN 'completed' THEN 'needs-action' ELSE 'completed' END,
                completed_at = CASE status WHEN 'completed' THEN NULL ELSE ? END
          WHERE task_id = ?`,
      )
      .run(ctx.now, input.task_id);
    ctx.wrote('schedule.task', input.task_id);
    return { task_id: input.task_id };
  },
};

// ---------- Important dates (birthdays auto-remind) ----------

const ADD_IMPORTANT_DATE: CommandDefinition = {
  name: 'people.add_important_date',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'label', 'month_day'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      label: { type: 'string', minLength: 1 },
      // MM-DD; the year of a recurring date is meaningless.
      month_day: { type: 'string', pattern: '^\\d{2}-\\d{2}$' },
      reminder_on: { type: 'boolean' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['date_id'],
    properties: { date_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'date_added',
      sql: 'SELECT count(*) AS n FROM people_important_date WHERE date_id = :date_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // A birthday label must leave core_party.birth_date's MM-DD agreeing with
      // this row (issue #441 A2.3); a no-op for non-birthday dates.
      name: 'birthday_reconciled',
      sql: `SELECT (CASE WHEN :label NOT LIKE '%birthday%' THEN 1
                    ELSE EXISTS(SELECT 1 FROM core_party
                                 WHERE party_id = :party_id
                                   AND substr(birth_date, -5) = :month_day) END) AS n`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      party_id: string;
      label: string;
      month_day: string;
      reminder_on?: boolean;
    };
    // Monica behavior: a birthday auto-creates its reminder.
    const isBirthday = /birthday/i.test(input.label);
    const reminder = isBirthday ? 1 : input.reminder_on ? 1 : 0;
    const dateId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO people_important_date (date_id, party_id, label, month_day, reminder_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(dateId, input.party_id, input.label, input.month_day, reminder, ctx.now);
    ctx.wrote('people.important_date', dateId);
    // A birthday is one logical fact (issue #441 A2.3): write it through to the
    // canonical party spine so core_party.birth_date and this row cannot
    // disagree. Preserve a known birth year if one is already recorded;
    // otherwise store the year-less ISO 8601 form (--MM-DD), since a birthday's
    // year is genuinely unknown here. (update_party reconciles the reverse.)
    if (isBirthday) {
      const party = ctx.db
        .prepare('SELECT birth_date FROM core_party WHERE party_id = ?')
        .get(input.party_id) as { birth_date: string | null } | undefined;
      const existing = party?.birth_date ?? null;
      const yearPrefix =
        existing && /^\d{4}-\d{2}-\d{2}$/.test(existing) ? existing.slice(0, 4) : '-';
      const birthDate = `${yearPrefix}-${input.month_day}`;
      if (birthDate !== existing) {
        ctx.db
          .prepare('UPDATE core_party SET birth_date = ?, updated_at = ? WHERE party_id = ?')
          .run(birthDate, ctx.now, input.party_id);
        ctx.wrote('core.party', input.party_id);
      }
      // Birthday is single-valued: keep any other "Birthday" rows for this
      // party in step so no two surfaces ever disagree on the MM-DD.
      const others = ctx.db
        .prepare(
          `SELECT date_id FROM people_important_date
            WHERE party_id = ? AND label LIKE '%birthday%' AND date_id <> ? AND month_day <> ?
              AND deleted_at IS NULL`,
        )
        .all(input.party_id, dateId, input.month_day) as { date_id: string }[];
      for (const other of others) {
        ctx.db
          .prepare('UPDATE people_important_date SET month_day = ? WHERE date_id = ?')
          .run(input.month_day, other.date_id);
        ctx.wrote('people.important_date', other.date_id);
      }
    }
    return { date_id: dateId };
  },
};

const TOGGLE_REMINDER: CommandDefinition = {
  name: 'people.toggle_reminder',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['date_id'],
    additionalProperties: false,
    properties: { date_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['date_id'],
    properties: { date_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'date_exists',
      sql: 'SELECT count(*) AS n FROM people_important_date WHERE date_id = :date_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { date_id: string };
    ctx.db
      .prepare('UPDATE people_important_date SET reminder_on = 1 - reminder_on WHERE date_id = ?')
      .run(input.date_id);
    ctx.wrote('people.important_date', input.date_id);
    return { date_id: input.date_id };
  },
};

// ---------- Relationships ----------

const ADD_RELATIONSHIP: CommandDefinition = {
  name: 'people.add_relationship',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'name', 'kind'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
      kind: { type: 'string', minLength: 1 },
      pet: { type: 'string' },
      related_party_id: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['relationship_id'],
    properties: { relationship_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'relationship_added',
      sql: `SELECT count(*) AS n FROM core_link
             WHERE link_id = :relationship_id AND from_type = 'core.party'
               AND from_id = :party_id AND to_type = 'core.party' AND valid_to IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      party_id: string;
      name: string;
      kind: string;
      pet?: string;
      related_party_id?: string;
    };
    const targetKind = input.pet ? 'animal' : 'person';
    let targetId = input.related_party_id;
    if (targetId) {
      const target = ctx.db
        .prepare('SELECT 1 AS n FROM core_party WHERE party_id = ?')
        .get(targetId);
      if (!target) throw new Error(`no related party ${targetId}`);
    } else {
      const existing = ctx.db
        .prepare(
          `SELECT party_id FROM core_party
            WHERE kind = ? AND display_name = ? COLLATE NOCASE
            ORDER BY party_id LIMIT 1`,
        )
        .get(targetKind, input.name) as { party_id: string } | undefined;
      targetId = existing?.party_id;
      if (!targetId) {
        targetId = ctx.newId();
        ctx.db
          .prepare(
            `INSERT INTO core_party
               (party_id, kind, display_name, sort_name, birth_date, avatar_content_id,
                created_at, updated_at, ontology_version)
             VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
          )
          .run(targetId, targetKind, input.name, ctx.now, ctx.now, ONTOLOGY_VERSION);
        ctx.wrote('core.party', targetId);
      }
    }
    const relationNotation = `people-${slug(input.kind)}${input.pet ? `-${slug(input.pet)}` : ''}`;
    const relationConceptId = conceptId(
      ctx,
      RELATIONS_SCHEME_URI,
      'Link relation types',
      relationNotation,
      input.kind,
    );
    const relationshipId = linkToParty(
      ctx,
      'core.party',
      input.party_id,
      targetId,
      relationConceptId,
    );
    return { relationship_id: relationshipId };
  },
};

// ---------- Gifts (canonical schedule tasks linked to their recipient) ----------

const ADD_GIFT: CommandDefinition = {
  name: 'people.add_gift',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'text'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['gift_id'],
    properties: { gift_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'gift_added',
      sql: `SELECT count(*) AS n FROM schedule_task t
             JOIN core_link l ON l.from_type = 'schedule.task' AND l.from_id = t.task_id
            WHERE t.task_id = :gift_id AND l.to_type = 'core.party'
              AND l.to_id = :party_id AND l.valid_to IS NULL`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { party_id: string; text: string };
    const giftId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO schedule_task
           (task_id, owner_party_id, title, description, status, priority, due_at,
            completed_at, effort_min, parent_task_id, rrule, remind_before_min)
         VALUES (?, ?, ?, NULL, 'needs-action', 0, NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(giftId, ownerPartyId(ctx), input.text);
    ctx.wrote('schedule.task', giftId);
    const giftFor = conceptId(
      ctx,
      RELATIONS_SCHEME_URI,
      'Link relation types',
      'gift-for',
      'Gift for',
    );
    linkToParty(ctx, 'schedule.task', giftId, input.party_id, giftFor);
    return { gift_id: giftId };
  },
};

const TOGGLE_GIFT: CommandDefinition = {
  name: 'people.toggle_gift',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['gift_id'],
    additionalProperties: false,
    properties: { gift_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['gift_id'],
    properties: { gift_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'gift_exists',
      sql: `SELECT count(*) AS n FROM schedule_task t
             JOIN core_link l ON l.from_type = 'schedule.task' AND l.from_id = t.task_id
             JOIN core_concept c ON c.concept_id = l.relation_concept_id
             JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
            WHERE t.task_id = :gift_id AND l.to_type = 'core.party' AND l.valid_to IS NULL
              AND s.uri = ${RELATIONS_SCHEME_URI_SQL} AND c.notation = 'gift-for'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { gift_id: string };
    ctx.db
      .prepare(
        `UPDATE schedule_task
            SET completed_at = CASE status WHEN 'completed' THEN NULL ELSE ? END,
                status = CASE status WHEN 'completed' THEN 'needs-action' ELSE 'completed' END
          WHERE task_id = ?`,
      )
      .run(ctx.now, input.gift_id);
    ctx.wrote('schedule.task', input.gift_id);
    return { gift_id: input.gift_id };
  },
};

// ---------- Debts ----------

const ADD_DEBT: CommandDefinition = {
  name: 'people.add_debt',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['party_id', 'direction', 'amount_minor'],
    additionalProperties: false,
    properties: {
      party_id: { type: 'string', minLength: 1 },
      direction: { type: 'string', enum: ['owe', 'owed'] },
      amount_minor: { type: 'integer', minimum: 1 },
      reason: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['debt_id'],
    properties: { debt_id: { type: 'string' } },
  },
  preconditions: [
    { name: 'person_exists', sql: PERSON_EXISTS_SQL, column: 'n', op: 'eq', value: 1 },
  ],
  postconditions: [
    {
      name: 'debt_added',
      sql: 'SELECT count(*) AS n FROM tally_obligation WHERE obligation_id = :debt_id',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as {
      party_id: string;
      direction: string;
      amount_minor: number;
      reason?: string;
    };
    const debtId = ctx.newId();
    const owner = ownerPartyId(ctx);
    const fromParty = input.direction === 'owe' ? owner : input.party_id;
    const toParty = input.direction === 'owe' ? input.party_id : owner;
    const friend = ctx.db
      .prepare('SELECT friend_id FROM tally_friend WHERE party_id = ?')
      .get(input.party_id) as { friend_id: string } | undefined;
    if (!friend) {
      const friendId = ctx.newId();
      ctx.db
        .prepare('INSERT INTO tally_friend (friend_id, party_id, created_at) VALUES (?, ?, ?)')
        .run(friendId, input.party_id, ctx.now);
      ctx.wrote('tally.friend', friendId);
    }
    ctx.db
      .prepare(
        `INSERT INTO tally_obligation
           (obligation_id, from_party, to_party, amount_minor, currency, reason,
            incurred_on, settled_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        debtId,
        fromParty,
        toParty,
        input.amount_minor,
        baseCurrency(ctx),
        input.reason ?? null,
        ctx.now.slice(0, 10),
        ctx.now,
      );
    ctx.wrote('tally.obligation', debtId);
    return { debt_id: debtId };
  },
};

const SETTLE_DEBT: CommandDefinition = {
  name: 'people.settle_debt',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['debt_id'],
    additionalProperties: false,
    properties: { debt_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['debt_id'],
    properties: { debt_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'debt_open',
      sql: 'SELECT count(*) AS n FROM tally_obligation WHERE obligation_id = :debt_id AND settled_at IS NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'debt_settled',
      sql: 'SELECT count(*) AS n FROM tally_obligation WHERE obligation_id = :debt_id AND settled_at IS NOT NULL',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { debt_id: string };
    ctx.db
      .prepare('UPDATE tally_obligation SET settled_at = ? WHERE obligation_id = ?')
      .run(ctx.now, input.debt_id);
    ctx.wrote('tally.obligation', input.debt_id);
    return { debt_id: input.debt_id };
  },
};

// ---------- Lists (SKOS concepts, like Docs folders) ----------

const CREATE_LIST: CommandDefinition = {
  name: 'people.create_list',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: { name: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['list_id'],
    properties: { list_id: { type: 'string' } },
  },
  preconditions: [
    {
      // Lists keep distinct names — a receipted refusal beats two "Work"s.
      name: 'name_unused',
      sql: `SELECT count(*) AS n FROM core_concept c
              JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
             WHERE s.uri = '${LIST_SCHEME_URI}' AND c.pref_label = :name`,
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  postconditions: [
    {
      name: 'list_created',
      sql: 'SELECT count(*) AS n FROM core_concept WHERE concept_id = :list_id AND pref_label = :name',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { name: string };
    const schemeId = listSchemeId(ctx);
    const listId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, alt_labels_json, broader_concept_id, definition)
         VALUES (?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(listId, schemeId, listId, input.name);
    ctx.wrote('core.concept', listId);
    return { list_id: listId };
  },
};

const RENAME_LIST: CommandDefinition = {
  name: 'people.rename_list',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['list_id', 'name'],
    additionalProperties: false,
    properties: {
      list_id: { type: 'string', minLength: 1 },
      name: { type: 'string', minLength: 1 },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['list_id'],
    properties: { list_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'list_exists',
      sql: `SELECT count(*) AS n FROM core_concept c
              JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
             WHERE c.concept_id = :list_id AND s.uri = '${LIST_SCHEME_URI}'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  postconditions: [
    {
      name: 'name_applied',
      sql: 'SELECT count(*) AS n FROM core_concept WHERE concept_id = :list_id AND pref_label = :name',
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { list_id: string; name: string };
    ctx.db
      .prepare('UPDATE core_concept SET pref_label = ? WHERE concept_id = ?')
      .run(input.name, input.list_id);
    ctx.wrote('core.concept', input.list_id);
    return { list_id: input.list_id };
  },
};

const DELETE_LIST: CommandDefinition = {
  name: 'people.delete_list',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['list_id'],
    additionalProperties: false,
    properties: { list_id: { type: 'string', minLength: 1 } },
  },
  outputSchema: {
    type: 'object',
    required: ['list_id'],
    properties: { list_id: { type: 'string' } },
  },
  preconditions: [
    {
      name: 'list_exists',
      sql: `SELECT count(*) AS n FROM core_concept c
              JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
             WHERE c.concept_id = :list_id AND s.uri = '${LIST_SCHEME_URI}'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
    {
      // Only empty lists delete — move the people out first.
      name: 'list_is_empty',
      sql: `SELECT EXISTS(SELECT 1 FROM core_tag
                           WHERE target_type = 'core.party' AND concept_id = :list_id) AS n`,
      column: 'n',
      op: 'eq',
      value: 0,
      message: 'This list still has people in it — move them out first.',
    },
  ],
  postconditions: [
    {
      name: 'list_removed',
      sql: 'SELECT count(*) AS n FROM core_concept WHERE concept_id = :list_id',
      column: 'n',
      op: 'eq',
      value: 0,
    },
  ],
  idempotency: 'idempotent',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { list_id: string };
    ctx.db.prepare('DELETE FROM core_concept WHERE concept_id = ?').run(input.list_id);
    cleanupPolyRefs(ctx.db, ctx.now, 'core.concept', input.list_id);
    ctx.wrote('core.concept', input.list_id);
    return { list_id: input.list_id };
  },
};

// ---------- Journal (owner-level, not per-person) ----------

const ADD_JOURNAL_ENTRY: CommandDefinition = {
  name: 'people.add_journal_entry',
  ownerSchema: 'people',
  inputSchema: {
    type: 'object',
    required: ['mood', 'text'],
    additionalProperties: false,
    properties: {
      mood: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
      entry_date: { type: 'string' },
    },
  },
  outputSchema: {
    type: 'object',
    required: ['entry_id'],
    properties: { entry_id: { type: 'string' } },
  },
  preconditions: [],
  postconditions: [
    {
      name: 'entry_added',
      sql: `SELECT count(*) AS n FROM knowledge_note n
             JOIN core_tag t ON t.target_type = 'knowledge.note' AND t.target_id = n.note_id
             JOIN core_concept c ON c.concept_id = t.concept_id
             JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
            WHERE n.note_id = :entry_id AND s.uri = '${JOURNAL_SCHEME_URI}'
              AND c.notation = 'entry'`,
      column: 'n',
      op: 'eq',
      value: 1,
    },
  ],
  idempotency: 'once',
  risk: 'low',
  handler: (ctx) => {
    const input = ctx.input as { mood: string; text: string; entry_date?: string };
    const entryId = ctx.newId();
    const entryDate = input.entry_date ?? ctx.now.slice(0, 10);
    const contentId = contentItemFor(ctx, input.text, 'plain');
    ctx.db
      .prepare(
        `INSERT INTO knowledge_note
           (note_id, author_party_id, title, body_content_id, format, pinned,
            created_at, updated_at, deleted_at, purge_at)
         VALUES (?, ?, ?, ?, 'plain', 0, ?, ?, NULL, NULL)`,
      )
      .run(
        entryId,
        ownerPartyId(ctx),
        `People journal · ${input.mood}`,
        contentId,
        `${entryDate}T12:00:00.000Z`,
        ctx.now,
      );
    ctx.wrote('knowledge.note', entryId);
    const marker = conceptId(ctx, JOURNAL_SCHEME_URI, 'People journal', 'entry', 'Journal entry');
    const tagId = ctx.newId();
    ctx.db
      .prepare(
        `INSERT INTO core_tag
           (tag_id, target_type, target_id, concept_id, tagged_by_party_id, confidence, tagged_at)
         VALUES (?, 'knowledge.note', ?, ?, ?, NULL, ?)`,
      )
      .run(tagId, entryId, marker, actorPartyId(ctx), ctx.now);
    ctx.wrote('core.tag', tagId);
    return { entry_id: entryId };
  },
};

/** Register the People commands on a gateway. */
export function registerPeopleCommands(gateway: Gateway): void {
  gateway.registerCommand(ADD_PERSON);
  gateway.registerCommand(EDIT_PERSON);
  gateway.registerCommand(SET_CADENCE);
  gateway.registerCommand(LOG_INTERACTION);
  gateway.registerCommand(STAR_PERSON);
  gateway.registerCommand(UNSTAR_PERSON);
  gateway.registerCommand(MOVE_PERSON);
  gateway.registerCommand(ADD_NOTE);
  gateway.registerCommand(ADD_TASK);
  gateway.registerCommand(TOGGLE_TASK);
  gateway.registerCommand(ADD_IMPORTANT_DATE);
  gateway.registerCommand(TOGGLE_REMINDER);
  gateway.registerCommand(ADD_RELATIONSHIP);
  gateway.registerCommand(ADD_GIFT);
  gateway.registerCommand(TOGGLE_GIFT);
  gateway.registerCommand(ADD_DEBT);
  gateway.registerCommand(SETTLE_DEBT);
  gateway.registerCommand(CREATE_LIST);
  gateway.registerCommand(RENAME_LIST);
  gateway.registerCommand(DELETE_LIST);
  gateway.registerCommand(ADD_JOURNAL_ENTRY);
}
