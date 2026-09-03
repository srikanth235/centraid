import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { VaultDb } from "../db.js";
import { registerContentTextFn } from "../schema/fts.js";
import { isSealedValue, SEALED_PLACEHOLDER } from "../schema/sealed.js";
import { GatewayError } from "./types.js";

export const VAULT_SQL_DEFAULT_ROWS = 200;
export const VAULT_SQL_MAX_ROWS = 1000;

export interface VaultSqlRequest {
  sql: string;
  maxRows?: number;
  purpose?: string;
}

export interface VaultSqlRows {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  truncated: boolean;
  durationMs: number;
}

export type VaultSqlResult = VaultSqlRows & { receiptId: string };

const COMMENT_RE = /\/\*[\s\S]*?\*\//gu;
const LINE_COMMENT_RE = /--[^\n]*/gu;

export function readOnlySqlRefusal(sql: string): string | undefined {
  const stripped = sql
    .replace(COMMENT_RE, " ")
    .replace(LINE_COMMENT_RE, " ")
    .trim()
    .replace(/;+\s*$/u, "");
  if (!stripped) return "empty statement";
  if (stripped.includes(";"))
    return 'one statement per call — drop the extra ";"';
  const first = stripped
    .match(/^(?<keyword>[A-Za-z]+)/u)
    ?.groups?.keyword?.toUpperCase();
  if (first !== "SELECT" && first !== "WITH" && first !== "EXPLAIN") {
    return "only SELECT / WITH … SELECT / EXPLAIN are allowed here";
  }
  if (
    /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|attach|detach|vacuum|reindex|pragma)\b/iu.test(
      stripped
    )
  ) {
    return "statement contains write/DDL syntax — this surface is read-only";
  }
  return undefined;
}

export function runReadOnlySql(
  db: VaultDb,
  sql: string,
  maxRows: number
): VaultSqlRows {
  const refusal = readOnlySqlRefusal(sql);
  if (refusal) throw new GatewayError("contract", refusal);
  const cap = Math.min(Math.max(maxRows, 1), VAULT_SQL_MAX_ROWS);

  const dedicated = db.dir !== ":memory:";
  const conn = dedicated
    ? new DatabaseSync(path.join(db.dir, "vault.db"))
    : db.vault;
  try {
    if (dedicated) {
      conn.exec("PRAGMA query_only = ON");
      registerContentTextFn(conn);
    }
    const started = Date.now();
    const executable = /^\s*EXPLAIN\b/iu.test(sql)
      ? sql
      : `SELECT * FROM (${sql.replace(/;+\s*$/u, "")}) AS centraid_bounded_query LIMIT ${cap + 1}`;
    const all = conn.prepare(executable).all() as Record<string, unknown>[];
    const durationMs = Date.now() - started;
    const rows = all.slice(0, cap);
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        if (isSealedValue(v)) row[k] = SEALED_PLACEHOLDER;
      }
    }
    return {
      columns: rows[0]
        ? Object.keys(rows[0])
        : all[0]
          ? Object.keys(all[0])
          : [],
      rows,
      totalRows: all.length,
      truncated: all.length > rows.length,
      durationMs,
    };
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayError("execution", `sql failed: ${message}`);
  } finally {
    if (dedicated) {
      try {
        conn.close();
      } catch {
        // Intentionally empty.
      }
    }
  }
}
