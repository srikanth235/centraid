// The policy cascade's rule STORE (issue #807) — reads and writes of
// `enrich_policy_rule`, and nothing else.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: resolve. There is no
// `mayThisRun(...)` here and there must not be. `decideEnrichmentGate`
// (packages/server/src/automation/fire/enrich-gate.ts) is the one gate on the
// execution path; a storage-level answer to the same question would be a
// second policy path, and the two would diverge the first time either grew a
// rule the other did not. What this module offers is the material that
// resolver reads: the rule at one scope, and every rule along a scope chain
// in cascade order.
//
// A rule states ONLY what its scope decides — `null` fields mean inherit (see
// the DDL's CHECK: a row that decides nothing is unrepresentable). Ordering
// least-specific-first is a property of the STORE, not a resolution: it is
// the order a resolver folds, and the order an audit view lists.

import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";

/** The cascade levels, least to most specific — the DDL CHECKs this set. */
export const ENRICH_SCOPE_TYPES = [
  "vault",
  "domain",
  "collection",
  "item",
] as const;
export type EnrichScopeType = (typeof ENRICH_SCOPE_TYPES)[number];

/** When a capability's work is offered for a scope. */
export const ENRICH_TRIGGERS = ["on-ingest", "on-view", "on-demand"] as const;
export type EnrichTrigger = (typeof ENRICH_TRIGGERS)[number];

/** One level of the cascade. `ref` is `''` at vault scope (DDL-enforced). */
export interface EnrichScope {
  type: EnrichScopeType;
  ref: string;
}

/** What one scope decides about one capability; `null` is inherit. */
export interface EnrichPolicyRule {
  scope: EnrichScope;
  capability: string;
  enabled: boolean | null;
  /** The engine profile this scope points the capability at. */
  profile: string | null;
  trigger: EnrichTrigger | null;
  updatedAt: string;
}

export interface EnrichPolicyRuleInput {
  scope: EnrichScope;
  capability: string;
  enabled?: boolean | null;
  profile?: string | null;
  trigger?: EnrichTrigger | null;
  now?: string;
}

interface RuleRow {
  scope_type: string;
  scope_ref: string;
  capability: string;
  enabled: number | null;
  profile: string | null;
  trigger_on: string | null;
  updated_at: string;
}

const SELECT_COLUMNS = `scope_type, scope_ref, capability, enabled, profile,
                        trigger_on, updated_at`;

const SCOPE_RANK = new Map(
  ENRICH_SCOPE_TYPES.map((type, index) => [type as string, index])
);

/**
 * Least-specific first. SQL cannot supply this order — `ORDER BY scope_type`
 * is alphabetical ('collection' before 'vault'), which reads as a cascade and
 * is not one.
 */
function byCascade(a: EnrichPolicyRule, b: EnrichPolicyRule): number {
  return (
    (SCOPE_RANK.get(a.scope.type) ?? 0) - (SCOPE_RANK.get(b.scope.type) ?? 0) ||
    a.scope.ref.localeCompare(b.scope.ref)
  );
}

function toRule(row: RuleRow): EnrichPolicyRule {
  return {
    scope: { type: row.scope_type as EnrichScopeType, ref: row.scope_ref },
    capability: row.capability,
    enabled: row.enabled === null ? null : row.enabled === 1,
    profile: row.profile,
    trigger: row.trigger_on as EnrichTrigger | null,
    updatedAt: row.updated_at,
  };
}

/**
 * Write the rule for one (scope, capability), replacing whatever that scope
 * decided before. Fields left undefined are stored as `null` — a rewrite
 * states the whole decision, so "stop deciding the trigger here" is expressible
 * without a second call. Rejected by the DDL when the result decides nothing.
 *
 * The caller owns the transaction, like every other vault-side writer here.
 */
export function putEnrichPolicyRule(
  vault: DatabaseSync,
  input: EnrichPolicyRuleInput
): void {
  const enabled = input.enabled ?? null;
  vault
    .prepare(
      `INSERT INTO enrich_policy_rule
         (rule_id, scope_type, scope_ref, capability, enabled, profile,
          trigger_on, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (scope_type, scope_ref, capability) DO UPDATE SET
         enabled = excluded.enabled,
         profile = excluded.profile,
         trigger_on = excluded.trigger_on,
         updated_at = excluded.updated_at`
    )
    .run(
      uuidv7(),
      input.scope.type,
      input.scope.ref,
      input.capability,
      enabled === null ? null : enabled ? 1 : 0,
      input.profile ?? null,
      input.trigger ?? null,
      input.now ?? nowIso()
    );
}

/** Drop one scope's rule for a capability — that scope stops deciding. */
export function deleteEnrichPolicyRule(
  vault: DatabaseSync,
  scope: EnrichScope,
  capability: string
): void {
  vault
    .prepare(
      `DELETE FROM enrich_policy_rule
        WHERE scope_type = ? AND scope_ref = ? AND capability = ?`
    )
    .run(scope.type, scope.ref, capability);
}

/** The rule one scope states for one capability, or `null` when it states none. */
export function readEnrichPolicyRule(
  vault: DatabaseSync,
  scope: EnrichScope,
  capability: string
): EnrichPolicyRule | null {
  const row = vault
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM enrich_policy_rule
        WHERE scope_type = ? AND scope_ref = ? AND capability = ?`
    )
    .get(scope.type, scope.ref, capability) as RuleRow | undefined;
  return row ? toRule(row) : null;
}

/**
 * Every rule for `capability` along an explicit scope chain, ordered
 * least-specific first. The caller supplies the chain because only it knows
 * which collection an item is in; this module never guesses an item's scopes.
 * Scopes with no rule are simply absent — inheritance is the absence.
 */
export function readEnrichPolicyRuleChain(
  vault: DatabaseSync,
  chain: readonly EnrichScope[],
  capability: string
): EnrichPolicyRule[] {
  return chain
    .flatMap((scope) => {
      const rule = readEnrichPolicyRule(vault, scope, capability);
      return rule ? [rule] : [];
    })
    .sort(byCascade);
}

/** Every rule mentioning one capability — the audit view's read. */
export function listEnrichPolicyRules(
  vault: DatabaseSync,
  capability: string
): EnrichPolicyRule[] {
  return (
    vault
      .prepare(
        `SELECT ${SELECT_COLUMNS} FROM enrich_policy_rule WHERE capability = ?`
      )
      .all(capability) as unknown as RuleRow[]
  )
    .map(toRule)
    .sort(byCascade);
}
