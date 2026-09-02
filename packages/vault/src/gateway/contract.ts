// S3 — Contract: is this a valid typed command? Writes are never rows, only
// commands (rule R04). Payloads validate against JSON-Schema; pre- and
// postconditions are real queries evaluated by the gateway and recorded as
// agent.invocation_check rows.

import type { DatabaseSync } from "node:sqlite";

import type { ConditionSpec, Risk } from "./types.js";

export interface CommandRow {
  command_id: string;
  name: string;
  owner_schema: string;
  input_schema_json: string;
  output_schema_json: string;
  preconditions_json: string;
  postconditions_json: string;
  idempotency: "idempotent" | "once" | "retry-safe";
  risk: Risk;
  ontology_version: string;
}

export function lookupCommand(
  vault: DatabaseSync,
  name: string
): CommandRow | undefined {
  return vault
    .prepare("SELECT * FROM agent_command WHERE name = ?")
    .get(name) as CommandRow | undefined;
}

export interface ConditionResult {
  name: string;
  predicate: string;
  /** The spec's owner-facing `message`, when it supplied one. */
  message?: string;
  passed: boolean;
  observed: Record<string, unknown>;
}

function compare(
  op: ConditionSpec["op"],
  actual: unknown,
  expected: number | string
): boolean {
  if (actual === null || actual === undefined) return false;
  const a = actual as number | string;
  switch (op) {
    case "eq":
      return a === expected;
    case "ne":
      return a !== expected;
    case "lt":
      return a < expected;
    case "lte":
      return a <= expected;
    case "gt":
      return a > expected;
    case "gte":
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
  input: Record<string, unknown>
): ConditionResult[] {
  return specs.map((spec) => {
    const predicate = `${spec.name}: ${spec.column} ${spec.op} ${JSON.stringify(spec.value)}`;
    try {
      const params: Record<string, string | number | null> = {};
      for (const match of spec.sql.matchAll(/:(?<param>[a-z_][a-z0-9_]*)/giu)) {
        const key = match.groups?.param as string;
        const value = input[key];
        params[key] =
          typeof value === "string" || typeof value === "number"
            ? value
            : value === null || value === undefined
              ? null // optional inputs bind as NULL, so conditions can branch on them
              : String(value);
      }
      const row = (vault.prepare(spec.sql).get(params) ?? {}) as Record<
        string,
        unknown
      >;
      return {
        name: spec.name,
        predicate,
        message: spec.message,
        passed: compare(spec.op, row[spec.column], spec.value),
        observed: row,
      };
    } catch (error) {
      return {
        name: spec.name,
        predicate,
        message: spec.message,
        passed: false,
        observed: {
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}

// The judgment veto is gone with `agent.judgment` (#916, ruling ONT-06): the
// learn loop had commands, a table and no caller, so no correction was ever
// distilled into a rule and no call was ever vetoed. R08 stays a design
// commitment; it will need a producer before it needs a consultation.
