// S2 — Consent: may this caller see or do this? The RLS replacement: a chain
// of checks, any of which can independently deny. A deny is an outcome, not
// an exception — the caller of evaluateConsent turns a Denial into a
// receipted deny row.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../ids.js';
import type { FilterClause, Identity } from './types.js';

export interface GrantRow {
  grant_id: string;
  purpose_notation: string;
  expires_at: string | null;
}

export interface ScopeRow {
  scope_id: string;
  grant_id: string;
  schema_name: string;
  table_name: string | null;
  verbs: 'read' | 'read+act' | 'act';
  row_filter_json: string | null;
  field_mask_json: string | null;
}

export interface ConsentAllow {
  decision: 'allow';
  /** NULL for owner-direct action. */
  grantId: string | null;
  rowFilter: FilterClause[];
  fieldMask: string[] | null;
}
export interface ConsentDeny {
  decision: 'deny';
  /** Which check failed — recorded in the receipt detail. */
  failing: string;
  grantId: string | null;
}
export type ConsentDecision = ConsentAllow | ConsentDeny;

function activeGrants(vault: DatabaseSync, identity: Identity, purpose: string): GrantRow[] {
  const now = nowIso();
  const selector =
    identity.kind === 'app'
      ? { column: 'g.app_id', value: identity.callerId }
      : { column: 'g.grantee_party_id', value: identity.partyId };
  if (selector.value === null) return [];
  const rows = vault
    .prepare(
      `SELECT g.grant_id, c.notation AS purpose_notation, g.expires_at
         FROM consent_access_grant g
         JOIN core_concept c ON c.concept_id = g.purpose_concept_id
        WHERE ${selector.column} = ?
          AND g.status = 'active'
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > ?)`,
    )
    .all(selector.value, now) as unknown as GrantRow[];
  return rows.filter((g) => g.purpose_notation === purpose);
}

function scopesFor(
  vault: DatabaseSync,
  grantId: string,
  schema: string,
  table: string,
): ScopeRow[] {
  return vault
    .prepare(
      `SELECT scope_id, grant_id, schema_name, table_name, verbs, row_filter_json, field_mask_json
         FROM consent_grant_scope
        WHERE grant_id = ? AND schema_name = ? AND (table_name IS NULL OR table_name = ?)`,
    )
    .all(grantId, schema, table) as unknown as ScopeRow[];
}

/**
 * consent.policy kind='minimization': a table under such a policy is excluded
 * from default (schema-wide) grant scopes — only a scope naming it explicitly
 * covers it. This is how "condition rows are excluded from default scopes"
 * (§03/§07) is data, not code.
 */
function requiresExplicitScope(vault: DatabaseSync, schema: string, table: string): boolean {
  const row = vault
    .prepare(
      `SELECT count(*) AS n FROM consent_policy
        WHERE kind = 'minimization' AND applies_schema = ? AND applies_table = ?
          AND effective_from <= ?`,
    )
    .get(schema, table, nowIso()) as { n: number };
  return row.n > 0;
}

/** Standing consent.policy purpose rules: {"allowed_purposes": [...]}. */
function purposePermitted(
  vault: DatabaseSync,
  schema: string,
  table: string,
  purpose: string,
): boolean {
  const rows = vault
    .prepare(
      `SELECT rule_json FROM consent_policy
        WHERE kind = 'purpose' AND applies_schema = ?
          AND (applies_table IS NULL OR applies_table = ?)
          AND effective_from <= ?
        ORDER BY priority ASC`,
    )
    .all(schema, table, nowIso()) as { rule_json: string }[];
  for (const row of rows) {
    const rule = JSON.parse(row.rule_json) as { allowed_purposes?: string[] };
    if (Array.isArray(rule.allowed_purposes) && !rule.allowed_purposes.includes(purpose))
      return false;
  }
  return true;
}

/**
 * Evaluate the consent chain for one entity + verb. Owner-direct callers
 * bypass grants (they own the model) but still pass policy and still get
 * receipted by the caller of this function.
 */
export function evaluateConsent(
  vault: DatabaseSync,
  identity: Identity,
  schema: string,
  table: string,
  verb: 'read' | 'act',
  purpose: string,
): ConsentDecision {
  if (verb === 'act' && !identity.mayAct) {
    return { decision: 'deny', failing: 'device is readonly', grantId: null };
  }
  if (!purposePermitted(vault, schema, table, purpose)) {
    return {
      decision: 'deny',
      failing: `policy forbids purpose ${purpose} on ${schema}.${table}`,
      grantId: null,
    };
  }
  if (identity.kind === 'owner-device') {
    return { decision: 'allow', grantId: null, rowFilter: [], fieldMask: null };
  }
  const grants = activeGrants(vault, identity, purpose);
  if (grants.length === 0) {
    return { decision: 'deny', failing: `no active grant for purpose ${purpose}`, grantId: null };
  }
  const explicitOnly = requiresExplicitScope(vault, schema, table);
  for (const grant of grants) {
    for (const scope of scopesFor(vault, grant.grant_id, schema, table)) {
      const verbOk = verb === 'read' ? scope.verbs !== 'act' : scope.verbs !== 'read';
      if (!verbOk) continue;
      // High-sensitivity tables never ride a whole-schema scope.
      if (explicitOnly && scope.table_name === null) continue;
      return {
        decision: 'allow',
        grantId: grant.grant_id,
        rowFilter: scope.row_filter_json
          ? (JSON.parse(scope.row_filter_json) as FilterClause[])
          : [],
        fieldMask: scope.field_mask_json ? (JSON.parse(scope.field_mask_json) as string[]) : null,
      };
    }
  }
  return {
    decision: 'deny',
    failing: `no grant_scope covers ${schema}.${table} for verb ${verb}`,
    grantId: grants[0]?.grant_id ?? null,
  };
}
