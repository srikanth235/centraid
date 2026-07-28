// S2 — Consent: may this caller see or do this? The RLS replacement: a chain
// of checks, any of which can independently deny. A deny is an outcome, not
// an exception — the caller of evaluateConsent turns a Denial into a
// receipted deny row.

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
  schema_name: string;
  table_name: string | null;
  verbs: "read" | "read+act" | "act" | "reveal";
  row_filter_json: string | null;
  field_mask_json: string | null;
}

export interface ConsentAllow {
  decision: "allow";
  /** NULL for owner-direct action. */
  grantId: string | null;
  rowFilter: FilterClause[];
  fieldMask: string[] | null;
}
export interface ConsentDeny {
  decision: "deny";
  /** Which check failed — recorded in the receipt detail. */
  failing: string;
  grantId: string | null;
}
export type ConsentDecision = ConsentAllow | ConsentDeny;

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

/**
 * Ops that pin a column to a value set. Two scopes pinning the SAME column to
 * DIFFERENT values are alternatives ("row A or row B"), and the clamp ANDs, so
 * their conjunction matches nothing. Range ops (`lt`/`gte`/`within-days`/…)
 * are not alternatives — two of them on one column is a legitimate window.
 */
const PINNING_OPS = new Set<FilterClause["op"]>(["eq", "in"]);

/**
 * Reject a clamp that asks for a UNION. The clamp vocabulary has no OR: a
 * bounded union must be written as ONE scope with one `in` filter (see
 * `scopesForAutomationAnchors` in the gateway, which collapses same-table
 * anchors for exactly this reason). Two scopes pinning one column differently
 * are that union written wrong — refuse loudly rather than quietly read zero
 * rows or quietly honour whichever scope sorted first.
 */
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
 * The execution clamp for one entity + verb: EVERY manifest scope covering it,
 * intersected. Row filters AND together and field masks intersect, so a second
 * declaration on the same table can only ever narrow the first — no declared
 * restriction is dropped, and the result does not depend on the order the host
 * happened to list its scopes in.
 *
 * Explicit row/field anchors therefore attenuate a schema-wide declaration for
 * the anchored table while that declaration can still cover unrelated tables.
 * `undefined` (no covering scope at all) is a deny; an absent clamp is "no
 * manifest attenuation" and leaves the durable grant untouched.
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
      "consent",
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
  // Consent is first-match: preserve the owner's earliest still-active grant.
  // rowid makes grants approved in the same clock tick deterministic.
  const rows = vault
    .prepare(
      `SELECT g.grant_id, c.notation AS purpose_notation, g.expires_at
         FROM consent_access_grant g
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
      `SELECT scope_id, grant_id, schema_name, table_name, verbs, row_filter_json, field_mask_json
         FROM consent_grant_scope
        WHERE grant_id = ? AND schema_name = ? AND (table_name IS NULL OR table_name = ?)`
    )
    .all(grantId, schema, table) as unknown as ScopeRow[];
}

/**
 * consent.policy kind='minimization': a table under such a policy is excluded
 * from default (schema-wide) grant scopes — only a scope naming it explicitly
 * covers it. This is how "condition rows are excluded from default scopes"
 * (§03/§07) is data, not code.
 */
function requiresExplicitScope(
  vault: DatabaseSync,
  schema: string,
  table: string,
  evaluatedAt: string
): boolean {
  const row = vault
    .prepare(
      `SELECT count(*) AS n FROM consent_policy
        WHERE kind = 'minimization' AND applies_schema = ? AND applies_table = ?
          AND effective_from <= ?`
    )
    .get(schema, table, evaluatedAt) as { n: number };
  return row.n > 0;
}

/** Standing consent.policy purpose rules: {"allowed_purposes": [...]}. */
function purposePermitted(
  vault: DatabaseSync,
  schema: string,
  table: string,
  purpose: string,
  evaluatedAt: string
): boolean {
  const rows = vault
    .prepare(
      `SELECT rule_json FROM consent_policy
        WHERE kind = 'purpose' AND applies_schema = ?
          AND (applies_table IS NULL OR applies_table = ?)
          AND effective_from <= ?
        ORDER BY priority ASC`
    )
    .all(schema, table, evaluatedAt) as { rule_json: string }[];
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
  verb: "read" | "act" | "reveal",
  declaredPurpose?: string,
  evaluatedAt = nowIso()
): ConsentDecision {
  // Purposes are dormant, not deleted (issue #306 decision 4): an undeclared
  // purpose evaluates as the default, so policy rules still bite either way.
  const purpose = declaredPurpose ?? DEFAULT_PURPOSE;
  // Reveal is read-shaped but act-graded (issue #293): a readonly device may
  // browse placeholders, never dump secrets.
  if ((verb === "act" || verb === "reveal") && !identity.mayAct) {
    return { decision: "deny", failing: "device is readonly", grantId: null };
  }
  // The on-behalf-of cap (issue #599 decision 7): an agent turn is hard-capped
  // at the role of the member it acts for, so Sid's assistant fails exactly
  // where Sid would. Checked BEFORE grants, because no grant of the enrolled
  // agent's own can exceed the human it is working for.
  if (
    (verb === "act" || verb === "reveal") &&
    identity.onBehalfOfMember?.mayAct === false
  ) {
    return {
      decision: "deny",
      failing: `acting member ${identity.onBehalfOfMember.memberId} holds read-only in this vault`,
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
      // Reveal never rides read or act (issue #293): only an explicit
      // 'reveal' scope covers it, and a 'reveal' scope covers nothing else.
      if (!verbAllowed(scope.verbs, verb)) continue;
      // High-sensitivity tables never ride a whole-schema scope.
      if (explicitOnly && scope.table_name === null) continue;
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
