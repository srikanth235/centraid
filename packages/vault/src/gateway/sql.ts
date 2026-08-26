// Owner SQL: one read-only SELECT over the whole canonical model. Only the owner-device credential reaches this op, so consent scoping does not apply — remaining guards are operational (query_only, one statement, row cap), and every run is receipted.

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
  /** Rows observed up to cap + 1; when truncated this is a lower bound. */
  totalRows: number;
  truncated: boolean;
  durationMs: number;
}

export type VaultSqlResult = VaultSqlRows & { receiptId: string };

const COMMENT_RE = /\/\*[\s\S]*?\*\//gu;
const LINE_COMMENT_RE = /--[^\n]*/gu;

/** Lexical gate so a write fails clearly, and so `:memory:` (shared main handle; query_only cannot be toggled) still refuses writes. */
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
  // `:memory:` shares the writable main handle — this keyword screen is the only wall there. `replace(...)` the function stays usable; only `REPLACE INTO` would write (first-token check).
  if (
    /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|attach|detach|vacuum|reindex|pragma)\b/iu.test(
      stripped
    )
  ) {
    return "statement contains write/DDL syntax — this surface is read-only";
  }
  return undefined;
}

/** Dedicated `query_only` connection per on-disk call. In-memory vaults share the main handle and lean on the lexical gate. */
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
      // Fresh connection: FTS / canonical bodies call vault_content_text().
      registerContentTextFn(conn);
    }
    const started = Date.now();
    // Cap in SQLite's plan, not after `.all()` — slicing in JS still pays unbounded memory. One look-ahead row keeps `truncated` honest.
    const executable = /^\s*EXPLAIN\b/iu.test(sql)
      ? sql
      : `SELECT * FROM (${sql.replace(/;+\s*$/u, "")}) AS centraid_bounded_query LIMIT ${cap + 1}`;
    const all = conn.prepare(executable).all() as Record<string, unknown>[];
    const durationMs = Date.now() - started;
    const rows = all.slice(0, cap);
    // Ciphertext at rest cannot leak; rewrite sealed wire values (aliased or CONCAT'd) to the placeholder so transcripts stay readable.
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
        /* already closed */
      }
    }
  }
}
