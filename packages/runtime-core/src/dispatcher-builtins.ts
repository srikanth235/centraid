/**
 * Built-in handlers for the three-tool dispatcher.
 *
 * Names starting with `_` route here instead of looking up the
 * app's manifest. `_sql` is the only built-in today — an escape hatch
 * for asks the app author didn't declare. Same name routes through
 * both `centraid_write` (DML) and `centraid_read` (SELECT/EXPLAIN);
 * the guards mirror the legacy `centraid_sql_*` tools this replaces.
 *
 * Split out of `dispatcher.ts` to keep that file under the repo's
 * file-size limit; the dispatcher delegates here on a `_`-prefixed
 * handler name.
 */

import path from 'node:path';
import { appDataDir } from './app-paths.js';
import { readOp, writeOp, SqlOpRefusalError } from './sql-ops.js';
import { RunQueryError } from './run-query.js';
import type { RegistryEntry } from './types.js';
import type { ToolErrorResult, ToolResult } from './dispatcher.js';

/**
 * Closure the dispatcher hands in for building `ToolResult` envelopes.
 * Avoids re-exporting `errorResult` / `successResult` from the dispatcher.
 */
export interface BuiltinHelpers {
  errorResult: (
    code: 'INVALID_INPUT' | 'HANDLER_ERROR' | 'UNKNOWN_ACTION' | 'UNKNOWN_QUERY',
    message: string,
  ) => ToolErrorResult;
  successResult: (value: unknown) => ToolResult;
  /**
   * Optional change-bus emitter for the app. `_sql` write fires this
   * after a successful DML so the iframe and any other listener see
   * the precise list of mutated tables.
   */
  onWriteFor?: (appId: string) => (tables: string[]) => void;
}

export function runBuiltinWrite(
  entry: RegistryEntry,
  name: string,
  handlerInput: unknown,
  helpers: BuiltinHelpers,
): ToolResult {
  if (name === '_sql') return runSqlWrite(entry, handlerInput, helpers);
  return helpers.errorResult('UNKNOWN_ACTION', `no built-in action "${name}"`);
}

export function runBuiltinRead(
  entry: RegistryEntry,
  name: string,
  handlerInput: unknown,
  helpers: BuiltinHelpers,
): ToolResult {
  if (name === '_sql') return runSqlRead(entry, handlerInput, helpers);
  return helpers.errorResult('UNKNOWN_QUERY', `no built-in query "${name}"`);
}

function runSqlRead(
  entry: RegistryEntry,
  handlerInput: unknown,
  helpers: BuiltinHelpers,
): ToolResult {
  const sql = readSqlField(handlerInput);
  if (!sql) {
    return helpers.errorResult(
      'INVALID_INPUT',
      '_sql requires { sql: "<single SELECT or EXPLAIN>" }',
    );
  }
  try {
    const result = readOp({ dataFile: path.join(appDataDir(entry), 'data.sqlite'), sql });
    return helpers.successResult(result);
  } catch (err) {
    return sqlErrorToResult(err, helpers);
  }
}

function runSqlWrite(
  entry: RegistryEntry,
  handlerInput: unknown,
  helpers: BuiltinHelpers,
): ToolResult {
  const sql = readSqlField(handlerInput);
  if (!sql) {
    return helpers.errorResult(
      'INVALID_INPUT',
      '_sql requires { sql: "<single INSERT/UPDATE/DELETE/REPLACE>" }',
    );
  }
  try {
    const onWrite = helpers.onWriteFor?.(entry.id);
    const result = writeOp({
      dataFile: path.join(appDataDir(entry), 'data.sqlite'),
      sql,
      ...(onWrite ? { onWrite } : {}),
    });
    return helpers.successResult(result);
  } catch (err) {
    return sqlErrorToResult(err, helpers);
  }
}

function readSqlField(input: unknown): string | undefined {
  if (input && typeof input === 'object') {
    const sql = (input as { sql?: unknown }).sql;
    if (typeof sql === 'string' && sql.trim() !== '') return sql;
  }
  return undefined;
}

function sqlErrorToResult(err: unknown, helpers: BuiltinHelpers): ToolErrorResult {
  if (err instanceof SqlOpRefusalError) {
    return helpers.errorResult('INVALID_INPUT', err.message);
  }
  if (err instanceof RunQueryError) {
    return helpers.errorResult('HANDLER_ERROR', `${err.code}: ${err.message}`);
  }
  return helpers.errorResult('HANDLER_ERROR', err instanceof Error ? err.message : String(err));
}
