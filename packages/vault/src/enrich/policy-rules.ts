import type { DatabaseSync } from "node:sqlite";

import { nowIso, uuidv7 } from "../ids.js";

export const ENRICH_SCOPE_TYPES = [
  "vault",
  "domain",
  "collection",
  "item",
] as const;
export type EnrichScopeType = (typeof ENRICH_SCOPE_TYPES)[number];

export const ENRICH_TRIGGERS = ["on-ingest", "on-view", "on-demand"] as const;
export type EnrichTrigger = (typeof ENRICH_TRIGGERS)[number];

export interface EnrichScope {
  type: EnrichScopeType;
  ref: string;
}

export interface EnrichPolicyRule {
  scope: EnrichScope;
  capability: string;
  enabled: boolean | null;
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
