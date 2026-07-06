// The owner's SQL surface (vault assistant): a read-only SELECT over the
// WHOLE canonical model in one statement — joins, window functions, and
// recursive CTEs over core_link included. Single-tenant by construction:
// only the owner-device credential reaches this op (the gateway refuses
// everything else), so consent scoping does not apply — the remaining
// guards are operational (read-only execution, one statement, a row cap),
// and every run is still receipted so "what did my assistant look at" has
// an answer.

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import type { VaultDb } from '../db.js';
import { registerContentTextFn } from '../schema/fts.js';
import { isSealedValue, SEALED_PLACEHOLDER } from '../schema/sealed.js';
import { GatewayError } from './types.js';

/** Default and hard-max rows returned to the caller. */
export const VAULT_SQL_DEFAULT_ROWS = 200;
export const VAULT_SQL_MAX_ROWS = 1000;

export interface VaultSqlRequest {
  /** One read-only statement: SELECT, WITH … SELECT, or EXPLAIN. */
  sql: string;
  /** Rows returned (default 200, capped at 1000). Excess is truncated. */
  maxRows?: number;
  /** Receipt purpose tag. Defaults to `owner-assistant`. */
  purpose?: string;
}

export interface VaultSqlRows {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Rows the statement produced before the cap. */
  totalRows: number;
  truncated: boolean;
  durationMs: number;
}

export type VaultSqlResult = VaultSqlRows & { receiptId: string };

const COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /--[^\n]*/g;

/**
 * Lexical gate: one statement, read-shaped. Execution enforcement is
 * `PRAGMA query_only` on the dedicated connection — this check exists so a
 * write attempt fails with a clear refusal instead of a low-level SQLite
 * error, and so the `:memory:` fallback (tests share the main handle,
 * where query_only cannot be toggled) still refuses writes outright.
 */
export function readOnlySqlRefusal(sql: string): string | undefined {
  const stripped = sql
    .replace(COMMENT_RE, ' ')
    .replace(LINE_COMMENT_RE, ' ')
    .trim()
    .replace(/;+\s*$/, '');
  if (!stripped) return 'empty statement';
  if (stripped.includes(';')) return 'one statement per call — drop the extra ";"';
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'WITH' && first !== 'EXPLAIN') {
    return 'only SELECT / WITH … SELECT / EXPLAIN are allowed here';
  }
  // The :memory: fallback runs on the writable main handle, so the lexical
  // gate is the only wall there: keep the write/DDL keyword screen for that
  // path. `replace(...)` the FUNCTION stays usable — only `REPLACE INTO`
  // (statement position handled by the first-token check) would write.
  if (
    /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|attach|detach|vacuum|reindex|pragma)\b/i.test(
      stripped,
    )
  ) {
    return 'statement contains write/DDL syntax — this surface is read-only';
  }
  return undefined;
}

/**
 * Run one read-only statement against vault.db. On a real (on-disk) vault
 * this opens a dedicated `query_only` connection per call — writes fail at
 * execution no matter what the text sneaks past the lexical gate. The
 * in-memory vault (tests) shares the main handle and leans on the gate.
 */
export function runReadOnlySql(db: VaultDb, sql: string, maxRows: number): VaultSqlRows {
  const refusal = readOnlySqlRefusal(sql);
  if (refusal) throw new GatewayError('contract', refusal);
  const cap = Math.min(Math.max(maxRows, 1), VAULT_SQL_MAX_ROWS);

  const dedicated = db.dir !== ':memory:';
  const conn = dedicated ? new DatabaseSync(path.join(db.dir, 'vault.db')) : db.vault;
  try {
    if (dedicated) {
      conn.exec('PRAGMA query_only = ON');
      // The FTS index (and any query touching canonical bodies) calls
      // vault_content_text(); the fresh connection needs it registered.
      registerContentTextFn(conn);
    }
    const started = Date.now();
    const all = conn.prepare(sql).all() as Record<string, unknown>[];
    const durationMs = Date.now() - started;
    const rows = all.slice(0, cap);
    // Sealed cells are ciphertext at rest, so nothing here CAN leak — this
    // pass just keeps the assistant's transcripts readable: any sealed wire
    // value (however aliased or CONCAT'd) shows as the placeholder.
    for (const row of rows) {
      for (const [k, v] of Object.entries(row)) {
        if (isSealedValue(v)) row[k] = SEALED_PLACEHOLDER;
      }
    }
    return {
      columns: rows[0] ? Object.keys(rows[0]) : all[0] ? Object.keys(all[0]) : [],
      rows,
      totalRows: all.length,
      truncated: all.length > rows.length,
      durationMs,
    };
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new GatewayError('execution', `sql failed: ${message}`);
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
