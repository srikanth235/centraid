// S3 — Contract: is this a valid typed command? Writes are never rows, only
// commands (rule R04). Payloads validate against JSON-Schema; pre- and
// postconditions are real queries evaluated by the gateway and recorded as
// agent.invocation_check rows.

import type { DatabaseSync } from "node:sqlite";

import { isOperationCondition } from "./types.js";
import type { CommandCondition, ConditionSpec, Risk } from "./types.js";

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
 * THE ONE RESERVED CONDITION PARAMETER (#1020, R-1020-35).
 *
 * A condition that needs "now" binds `:ctx_now` and gets the SAME instant the
 * handler stamps as `ctx.now`. Before this the vault had TWO clocks: handlers
 * took the injected instant, and every condition that needed a time wrote
 * `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`, which is SQLite reading the host's
 * wall clock. The instance that bit was the trash window: `tally.delete_expense`
 * stamps `purge_at` at `ctx.now + 30 days` and its own postcondition asks
 * whether `purge_at` is still in the future, so under a frozen clock in the
 * past the command trashed the row and then rolled the whole thing back — a
 * refused write, with no wrong number to see it by. Seven other commands carry
 * the same restore-window predicate.
 *
 * It is reserved rather than merged with the input: a command input named
 * `now` would otherwise decide the vault's idea of the time.
 */
const RESERVED_NOW_PARAM = "ctx_now";

/**
 * Evaluate declarative conditions against the vault. Named params in the
 * condition SQL bind from command input, except `:ctx_now`, which binds the
 * caller's injected instant; a condition that errors (bad SQL, missing param)
 * fails closed.
 */
export function evaluateConditions(
  vault: DatabaseSync,
  specs: readonly CommandCondition[],
  input: Record<string, unknown>,
  now: string
): ConditionResult[] {
  return specs.map((spec) => {
    // A domain-operation condition (#996, R21): the same contract stage, with
    // a predicate that can read the proposed row image rather than one SQL
    // string. Its refusal sentence IS the message, so a member reads the
    // operation's words and the receipt keeps the operation's name.
    if (isOperationCondition(spec)) {
      const predicate = `${spec.operation}/${spec.name}`;
      try {
        const refusal = spec.assert(vault, input);
        return {
          name: spec.name,
          predicate,
          ...(refusal === null
            ? spec.message === undefined
              ? {}
              : { message: spec.message }
            : { message: refusal }),
          passed: refusal === null,
          observed: { operation: spec.operation },
        };
      } catch (error) {
        return {
          name: spec.name,
          predicate,
          ...(spec.message === undefined ? {} : { message: spec.message }),
          passed: false,
          observed: {
            error: error instanceof Error ? error.message : String(error),
          },
        };
      }
    }
    const predicate = `${spec.name}: ${spec.column} ${spec.op} ${JSON.stringify(spec.value)}`;
    try {
      const params: Record<string, string | number | null> = {};
      for (const match of spec.sql.matchAll(/:(?<param>[a-z_][a-z0-9_]*)/giu)) {
        const key = match.groups?.param as string;
        if (key === RESERVED_NOW_PARAM) {
          params[key] = now;
          continue;
        }
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
