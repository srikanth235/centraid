import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Registry } from '../registry/registry.js';
import { appDataDir } from '../registry/app-paths.js';
import { readTableRows, TableRowsError } from '../data/table-rows.js';
import { runQuery, RunQueryError } from '../handlers/run-query.js';
import { readLogs, type LogLevel } from '../data/log-store.js';
import { readBody, sendError, sendJson } from './http-utils.js';

/**
 * Handlers for the Cloud-panel HTTP routes (row browser, SQL editor, logs).
 *
 * Kept out of `index.ts` so the plugin entry stays under its governance
 * file-size cap. The routes share the registry + paths concerns of the
 * core dispatcher but don't need to know about versions/code dirs — they
 * only touch persistent app data (`<entry.path>/data.sqlite` and
 * `<entry.path>/logs.jsonl`), so they work in both uploaded and path mode.
 */

export async function handleTableRowsRoute(
  res: ServerResponse,
  registry: Registry,
  appId: string,
  tableName: string,
  query: Record<string, string>,
): Promise<true> {
  const entry = registry.get(appId);
  if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');

  const dataDbFile = path.join(appDataDir(entry), 'data.sqlite');
  const limit = parseIntOpt(query.limit);
  const offset = parseIntOpt(query.offset);

  try {
    const rows = readTableRows(dataDbFile, tableName, { limit, offset });
    return sendJson(res, 200, rows);
  } catch (err) {
    if (err instanceof TableRowsError) {
      const status = err.code === 'unknown_table' ? 404 : 400;
      return sendError(res, status, err.code, err.message);
    }
    throw err;
  }
}

export async function handleQueryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  registry: Registry,
  appId: string,
  /**
   * Called once after a successful write statement with the list of touched
   * tables. Skipped for read-style statements (which can't produce changes)
   * and for failed writes. Optional so callers without a change bus can
   * still use the route.
   */
  onWrite?: (tables: string[]) => void,
): Promise<true> {
  const entry = registry.get(appId);
  if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');

  let body: { sql?: unknown };
  try {
    body = JSON.parse((await readBody(req)).toString('utf8')) as { sql?: unknown };
  } catch {
    return sendError(res, 400, 'bad_request', 'Body must be JSON: { sql: string }.');
  }
  const sql = typeof body.sql === 'string' ? body.sql : '';
  if (!sql.trim()) {
    return sendError(res, 400, 'bad_request', 'Body must include non-empty `sql`.');
  }

  const dataDbFile = path.join(appDataDir(entry), 'data.sqlite');
  try {
    const result = runQuery(dataDbFile, sql, onWrite ? { onWrite } : undefined);
    return sendJson(res, 200, result);
  } catch (err) {
    if (err instanceof RunQueryError) {
      const status = err.code === 'bad_request' ? 400 : 422;
      return sendError(res, status, err.code, err.message);
    }
    throw err;
  }
}

export async function handleLogsRoute(
  res: ServerResponse,
  registry: Registry,
  appId: string,
  query: Record<string, string>,
): Promise<true> {
  const entry = registry.get(appId);
  if (!entry) return sendError(res, 404, 'not_found', 'App not registered.');

  const limit = parseIntOpt(query.limit);
  const sinceTs = parseIntOpt(query.sinceTs);
  const level = isLogLevel(query.level) ? query.level : undefined;

  const entries = await readLogs(appDataDir(entry), { limit, sinceTs, level });
  return sendJson(res, 200, { entries });
}

function parseIntOpt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function isLogLevel(s: string | undefined): s is LogLevel {
  return s === 'info' || s === 'warn' || s === 'error';
}
