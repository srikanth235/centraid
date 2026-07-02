// S3 — Contract: is this a valid typed command? Writes are never rows, only
// commands (rule R04). Payloads validate against JSON-Schema; pre- and
// postconditions are real queries evaluated by the gateway and recorded as
// agent.invocation_check rows; agent.judgment rules are consulted as
// constraints — never authored here.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../ids.js';
import type { ConditionSpec, Risk } from './types.js';

export interface CommandRow {
  command_id: string;
  name: string;
  owner_schema: string;
  input_schema_json: string;
  output_schema_json: string;
  preconditions_json: string;
  postconditions_json: string;
  idempotency: 'idempotent' | 'once' | 'retry-safe';
  risk: Risk;
  ontology_version: string;
}

export function lookupCommand(vault: DatabaseSync, name: string): CommandRow | undefined {
  return vault.prepare('SELECT * FROM agent_command WHERE name = ?').get(name) as
    | CommandRow
    | undefined;
}

export interface ConditionResult {
  name: string;
  predicate: string;
  passed: boolean;
  observed: Record<string, unknown>;
}

function compare(op: ConditionSpec['op'], actual: unknown, expected: number | string): boolean {
  if (actual === null || actual === undefined) return false;
  const a = actual as number | string;
  switch (op) {
    case 'eq':
      return a === expected;
    case 'ne':
      return a !== expected;
    case 'lt':
      return a < expected;
    case 'lte':
      return a <= expected;
    case 'gt':
      return a > expected;
    case 'gte':
      return a >= expected;
    default:
      return false;
  }
}

/**
 * Evaluate declarative conditions against the vault. Named params in the
 * condition SQL bind from command input; a condition that errors (bad SQL,
 * missing param) fails closed.
 */
export function evaluateConditions(
  vault: DatabaseSync,
  specs: ConditionSpec[],
  input: Record<string, unknown>,
): ConditionResult[] {
  return specs.map((spec) => {
    const predicate = `${spec.name}: ${spec.column} ${spec.op} ${JSON.stringify(spec.value)}`;
    try {
      const params: Record<string, string | number | null> = {};
      for (const match of spec.sql.matchAll(/:([a-z_][a-z0-9_]*)/gi)) {
        const key = match[1] as string;
        const value = input[key];
        params[key] =
          typeof value === 'string' || typeof value === 'number'
            ? value
            : value === null || value === undefined
              ? null // optional inputs bind as NULL, so conditions can branch on them
              : String(value);
      }
      const row = (vault.prepare(spec.sql).get(params) ?? {}) as Record<string, unknown>;
      return {
        name: spec.name,
        predicate,
        passed: compare(spec.op, row[spec.column], spec.value),
        observed: row,
      };
    } catch (err) {
      return {
        name: spec.name,
        predicate,
        passed: false,
        observed: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  });
}

/**
 * Consult active agent.judgment rows as constraints: a rule whose rule_json
 * carries {"veto_command": "<name>"} and whose subject_scope matches the
 * command's schema or full name vetoes the call (rule R08 — the owner's
 * distilled corrections can veto an otherwise-valid call).
 */
export function judgmentVeto(
  vault: DatabaseSync,
  commandName: string,
  ownerSchema: string,
): string | null {
  const rows = vault
    .prepare(
      `SELECT judgment_id, subject_scope, rule_json FROM agent_judgment
        WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)`,
    )
    .all(nowIso()) as { judgment_id: string; subject_scope: string; rule_json: string }[];
  for (const row of rows) {
    if (row.subject_scope !== commandName && row.subject_scope !== ownerSchema) continue;
    const rule = JSON.parse(row.rule_json) as { veto_command?: string };
    if (rule.veto_command === commandName) return row.judgment_id;
  }
  return null;
}
