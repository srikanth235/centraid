/*
 * Shared SQL operations exposed as agent tools.
 *
 * Three pure functions implement the read / write / describe surface that
 * both the in-process tool registrations (codex `dynamicTools`, claude SDK
 * MCP server) and the legacy `centraid` CLI bin call through. The bin keeps
 * working for human / scripted callers; agents prefer the inline tools.
 *
 * The functions are intentionally side-effect-free apart from SQLite
 * access — they take a `dataFile` arg rather than reading `process.cwd()`,
 * so they're trivially testable and reusable by multiple adapters in the
 * same process.
 */

import { readAppSchema } from './schema.js';
import { runQuery, RunQueryError } from './run-query.js';

export class SqlOpRefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlOpRefusalError';
  }
}

/**
 * Back-compat alias for the original `SqlOpRefusal` name. The shorter name
 * reads better at call sites (`err instanceof SqlOpRefusal`), but oxlint's
 * `custom-error-definition` rule wants the `Error` suffix on the class.
 */
export const SqlOpRefusal = SqlOpRefusalError;
export type SqlOpRefusal = SqlOpRefusalError;

/** Hard cap on rows returned to an agent — protects from runaway `SELECT *`. */
export const SELECT_ROW_CAP = 200;

const COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT_RE = /--[^\n]*/g;

function stripComments(sql: string): string {
  return sql.replace(COMMENT_RE, ' ').replace(LINE_COMMENT_RE, ' ').trim();
}

export function isSelectOnly(sql: string): boolean {
  const stripped = stripComments(sql);
  if (!stripped) return false;
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'SELECT' && first !== 'EXPLAIN') return false;
  return !/\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|pragma)\b/i.test(
    stripped,
  );
}

export function isWriteDml(sql: string): boolean {
  const stripped = stripComments(sql);
  if (!stripped) return false;
  const first = stripped.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase();
  if (first !== 'INSERT' && first !== 'UPDATE' && first !== 'DELETE' && first !== 'REPLACE') {
    return false;
  }
  return !/\b(drop|alter|create|attach|detach|vacuum|reindex|pragma)\b/i.test(stripped);
}

export interface DescribeResult {
  schemaVersion: number;
  tables: Array<{
    name: string;
    columns: Array<{ name: string; type: string; notnull: boolean; pk: boolean }>;
  }>;
  views: string[];
  indexes: Array<{ name: string; table: string }>;
}

export function describeOp(opts: { dataFile: string }): DescribeResult {
  const schema = readAppSchema(opts.dataFile);
  return {
    schemaVersion: schema.schemaVersion,
    tables: schema.tables.map((t) => ({
      name: t.name,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: c.type,
        notnull: c.notnull,
        pk: c.pk,
      })),
    })),
    views: schema.views.map((v) => v.name),
    indexes: schema.indexes.map((i) => ({ name: i.name, table: i.tbl_name })),
  };
}

export interface ReadResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  totalRows: number;
  truncated: boolean;
  durationMs: number;
}

export function readOp(opts: { dataFile: string; sql: string }): ReadResult {
  if (!isSelectOnly(opts.sql)) {
    throw new SqlOpRefusalError('only SELECT (or EXPLAIN) statements are allowed in sql_read');
  }
  const result = runQuery(opts.dataFile, opts.sql);
  if (result.kind !== 'rows') {
    throw new RunQueryError('sql_error', 'expected SELECT result; got an exec result');
  }
  const trimmed = result.rows.slice(0, SELECT_ROW_CAP);
  return {
    columns: result.columns,
    rows: trimmed,
    totalRows: result.rows.length,
    truncated: result.rows.length > trimmed.length,
    durationMs: result.durationMs,
  };
}

export interface WriteResult {
  rowsAffected: number;
  lastInsertRowid: number | string | null;
  durationMs: number;
}

export interface WriteOpOptions {
  dataFile: string;
  sql: string;
  /**
   * Optional change-tracking callback. Fired with the precise list of
   * mutated tables after a successful write. Errors thrown by the callback
   * are swallowed so they cannot change the SQL outcome.
   */
  onWrite?: (tables: string[]) => void;
}

export function writeOp(opts: WriteOpOptions): WriteResult {
  if (!isWriteDml(opts.sql)) {
    throw new SqlOpRefusalError(
      'only INSERT/UPDATE/DELETE/REPLACE are allowed in sql_write; DDL and PRAGMA are refused',
    );
  }
  const result = runQuery(
    opts.dataFile,
    opts.sql,
    opts.onWrite ? { onWrite: opts.onWrite } : undefined,
  );
  if (result.kind !== 'exec') {
    throw new RunQueryError('sql_error', 'expected exec result; got rows');
  }
  return {
    rowsAffected: result.rowsAffected,
    lastInsertRowid:
      typeof result.lastInsertRowid === 'bigint'
        ? result.lastInsertRowid.toString()
        : result.lastInsertRowid,
    durationMs: result.durationMs,
  };
}
