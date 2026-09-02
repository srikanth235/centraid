// S2 — Access: any check may deny; a deny is an outcome, not an exception.
//
// The plane is `access` — grants, scopes and policy answering "may this actor
// reach this data". The member's own act of consenting (provider egress, an
// automation's approval) is a different thing and keeps the word `consent`.

import type { DatabaseSync } from "node:sqlite";

import { nowIso } from "../ids.js";
import type { ExecutionScopeSpec, FilterClause, Identity } from "./types.js";
import { DEFAULT_PURPOSE, GatewayError } from "./types.js";

export interface GrantRow {
  grant_id: string;
  purpose_notation: string;
  expires_at: string | null;
}

export interface ScopeRow {
  scope_id: string;
  grant_id: string;
  /**
   * ONE DOTTED ENCODING (#916, R10): a bare pack name (`core`) for a
   * whole-pack scope, `core.event` for one entity — where a nullable
   * `schema_name`/`table_name` pair said the same thing in two columns and
   * four different ways across the plane.
   */
  entity: string;
  verbs: "read" | "read+act" | "act" | "reveal";
  row_filter_json: string | null;
  field_mask_json: string | null;
}

export interface AccessAllow {
  decision: "allow";
  grantId: string | null;
  rowFilter: FilterClause[];
  fieldMask: string[] | null;
}
export interface AccessDeny {
  decision: "deny";
  failing: string;
  grantId: string | null;
}
export type AccessDecision = AccessAllow | AccessDeny;

function verbAllowed(
  scopeVerb: ScopeRow["verbs"],
  requested: "read" | "act" | "reveal"
): boolean {
  return requested === "reveal"
    ? scopeVerb === "reveal"
    : requested === "read"
      ? scopeVerb === "read" || scopeVerb === "read+act"
      : scopeVerb === "act" || scopeVerb === "read+act";
}

function intersectFieldMasks(
  granted: readonly string[] | null,
  clamped: readonly string[] | null
): string[] | null {
  if (granted === null) return clamped === null ? null : [...clamped];
  if (clamped === null) return [...granted];
  const clamp = new Set(clamped);
  return granted.filter((field) => clamp.has(field));
}

/** `eq`/`in` pins; two scopes pinning one column differently are a forbidden union. */
const PINNING_OPS = new Set<FilterClause["op"]>(["eq", "in"]);

/** Clamp has no OR — a bounded union is one `in` filter, not two pin scopes. */
function conflictingPin(
  candidates: readonly ExecutionScopeSpec[]
): string | undefined {
  const pinned = new Map<string, string>();
  for (const scope of candidates) {
    for (const clause of scope.rowFilter ?? []) {
      if (!PINNING_OPS.has(clause.op)) continue;
      const seen = pinned.get(clause.column);
      const clauseJson = JSON.stringify(clause);
      if (seen === undefined) pinned.set(clause.column, clauseJson);
      else if (seen !== clauseJson) return clause.column;
    }
  }
  return undefined;
}

/**
 * Intersect every covering manifest scope: filters AND, masks intersect, order
 * independent. No covering scope is deny; empty clamp leaves the grant untouched.
 */
function executionClamp(
  identity: Identity,
  schema: string,
  table: string,
  verb: "read" | "act" | "reveal"
): { rowFilter: FilterClause[]; fieldMask: string[] | null } | undefined {
  if (!identity.scopeClamp) return { rowFilter: [], fieldMask: null };
  const candidates = identity.scopeClamp.filter(
    (scope) =>
      scope.schema === schema &&
      (scope.table === undefined || scope.table === table) &&
      verbAllowed(scope.verbs, verb)
  );
  if (candidates.length === 0) return undefined;
  const pin = conflictingPin(candidates);
  if (pin !== undefined) {
    throw new GatewayError(
      "access",
      `execution manifest pins ${schema}.${table}.${pin} in two different scopes for verb ${verb}` +
        ' — express a bounded union as one "in" filter, not as separate scopes'
    );
  }
  const rowFilter: FilterClause[] = [];
  const seenClauses = new Set<string>();
  let fieldMask: string[] | null = null;
  for (const scope of candidates) {
    for (const clause of scope.rowFilter ?? []) {
      const clauseJson = JSON.stringify(clause);
      if (seenClauses.has(clauseJson)) continue;
      seenClauses.add(clauseJson);
      rowFilter.push(clause);
    }
    fieldMask = intersectFieldMasks(fieldMask, scope.fieldMask ?? null);
  }
  return { rowFilter, fieldMask };
}

function activeGrants(
  vault: DatabaseSync,
  identity: Identity,
  purpose: string,
  evaluatedAt: string
): GrantRow[] {
  const selector =
    identity.kind === "app"
      ? { column: "g.app_id", value: identity.callerId }
      : { column: "g.grantee_party_id", value: identity.partyId };
  if (selector.value === null) return [];
  // First-match: earliest still-active grant; rowid breaks same-tick ties.
  const rows = vault
    .prepare(
      `SELECT g.grant_id, c.notation AS purpose_notation, g.expires_at
         FROM access_grant g
         JOIN core_concept c ON c.concept_id = g.purpose_concept_id
        WHERE ${selector.column} = ?
          AND g.status = 'active'
          AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > ?)
        ORDER BY g.granted_at ASC, g.rowid ASC`
    )
    .all(selector.value, evaluatedAt) as unknown as GrantRow[];
  return rows.filter((g) => g.purpose_notation === purpose);
}

function scopesFor(
  vault: DatabaseSync,
  grantId: string,
  schema: string,
  table: string
): ScopeRow[] {
  return vault
    .prepare(
      `SELECT scope_id, grant_id, entity, verbs, row_filter_json, field_mask_json
         FROM access_grant_scope
        WHERE grant_id = ? AND entity IN (?, ?)`
    )
    .all(grantId, schema, `${schema}.${table}`) as unknown as ScopeRow[];
}

/** Minimization policy: only an explicit table scope covers the table (§03/§07). */
function requiresExplicitScope(
  vault: DatabaseSync,
  schema: string,
  table: string,
  evaluatedAt: string
): boolean {
  const row = vault
    .prepare(
      `SELECT count(*) AS n FROM access_policy
        WHERE kind = 'minimization' AND entity = ?
          AND effective_from <= ?`
    )
    .get(`${schema}.${table}`, evaluatedAt) as { n: number };
  return row.n > 0;
}

/**
 * `entity` is ONE dotted column since #916 (R10): a policy either names a
 * whole schema (`core`) or one entity in it (`core.event`), where the pair of
 * nullable columns before it left "which entity" said four different ways.
 */
function purposePermitted(
  vault: DatabaseSync,
  schema: string,
  table: string,
  purpose: string,
  evaluatedAt: string
): boolean {
  const rows = vault
    .prepare(
      `SELECT rule_json FROM access_policy
        WHERE kind = 'purpose' AND entity IN (?, ?)
          AND effective_from <= ?
        ORDER BY priority ASC`
    )
    .all(schema, `${schema}.${table}`, evaluatedAt) as {
    rule_json: string;
  }[];
  for (const row of rows) {
    const rule = JSON.parse(row.rule_json) as { allowed_purposes?: string[] };
    if (
      Array.isArray(rule.allowed_purposes) &&
      !rule.allowed_purposes.includes(purpose)
    )
      return false;
  }
  return true;
}

/** Owner-direct bypasses grants but still passes policy. */
export function evaluateAccess(
  vault: DatabaseSync,
  identity: Identity,
  schema: string,
  table: string,
  verb: "read" | "act" | "reveal",
  declaredPurpose?: string,
  evaluatedAt = nowIso()
): AccessDecision {
  // Undeclared purpose evaluates as default; policy still applies (#306.4).
  const purpose = declaredPurpose ?? DEFAULT_PURPOSE;
  // Reveal is read-shaped, act-graded; readonly devices cannot dump secrets (#293).
  if ((verb === "act" || verb === "reveal") && !identity.mayAct) {
    return { decision: "deny", failing: "device is readonly", grantId: null };
  }
  // On-behalf-of cap: agent cannot exceed the acting owner (#599.7, #726). Before grants.
  if (
    (verb === "act" || verb === "reveal") &&
    identity.onBehalfOfOwner?.mayAct === false
  ) {
    return {
      decision: "deny",
      failing: `acting owner ${identity.onBehalfOfOwner.ownerId} does not own this vault`,
      grantId: null,
    };
  }
  if (!purposePermitted(vault, schema, table, purpose, evaluatedAt)) {
    return {
      decision: "deny",
      failing: `policy forbids purpose ${purpose} on ${schema}.${table}`,
      grantId: null,
    };
  }
  if (identity.kind === "owner-device") {
    return { decision: "allow", grantId: null, rowFilter: [], fieldMask: null };
  }
  const clamp = executionClamp(identity, schema, table, verb);
  if (!clamp) {
    return {
      decision: "deny",
      failing: `execution manifest does not declare ${schema}.${table} for verb ${verb}`,
      grantId: null,
    };
  }
  const grants = activeGrants(vault, identity, purpose, evaluatedAt);
  if (grants.length === 0) {
    return {
      decision: "deny",
      failing: `no active grant for purpose ${purpose}`,
      grantId: null,
    };
  }
  const explicitOnly = requiresExplicitScope(vault, schema, table, evaluatedAt);
  for (const grant of grants) {
    for (const scope of scopesFor(vault, grant.grant_id, schema, table)) {
      // Reveal never rides read or act (#293).
      if (!verbAllowed(scope.verbs, verb)) continue;
      // High-sensitivity tables never ride a whole-schema scope.
      if (explicitOnly && !scope.entity.includes(".")) continue;
      return {
        decision: "allow",
        grantId: grant.grant_id,
        rowFilter: [
          ...(scope.row_filter_json
            ? (JSON.parse(scope.row_filter_json) as FilterClause[])
            : []),
          ...clamp.rowFilter,
        ],
        fieldMask: intersectFieldMasks(
          scope.field_mask_json
            ? (JSON.parse(scope.field_mask_json) as string[])
            : null,
          clamp.fieldMask
        ),
      };
    }
  }
  return {
    decision: "deny",
    failing: `no grant_scope covers ${schema}.${table} for verb ${verb}`,
    grantId: grants[0]?.grant_id ?? null,
  };
}
