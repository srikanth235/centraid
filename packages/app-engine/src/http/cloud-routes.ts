import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Registry } from '../registry/registry.js';
import { appDataDir } from '../registry/app-paths.js';
import { readLogs, type LogLevel } from '../data/log-store.js';
import {
  deleteAppSetting,
  readAppSettings,
  RUNTIME_KEY_PREFIX,
  writeAppSetting,
} from '../settings/app-settings.js';
import { readBody, sendError, sendJson } from './http-utils.js';

/**
 * Handlers for the Cloud-panel logs route and the per-app settings.json
 * surface. The row-browser and SQL-editor routes died with the per-app
 * data.sqlite (issue #286 phase 2) — app data lives in the vault and is
 * browsed through the vault surfaces; what remains per-app is runtime
 * STATE (logs, settings).
 */

/**
 * Write one app-owned settings key (`PUT …/settings`, body
 * `{ key, value }`; `value: null` deletes). Runtime-owned keys (prefix
 * `__`) are refused — those are the runtime's own (automation toggles).
 */
export async function handleSettingsWrite(
  req: IncomingMessage,
  res: ServerResponse,
  appDir: string,
): Promise<true> {
  let body: { key?: unknown; value?: unknown };
  try {
    body = JSON.parse((await readBody(req)).toString('utf8')) as { key?: unknown; value?: unknown };
  } catch {
    return sendError(res, 400, 'bad_request', 'Body must be JSON: { key, value }.');
  }
  const key = typeof body.key === 'string' ? body.key : '';
  if (!key) return sendError(res, 400, 'bad_request', 'Body must include a string `key`.');
  if (key.startsWith(RUNTIME_KEY_PREFIX)) {
    return sendError(res, 400, 'bad_request', 'Keys starting with "__" are runtime-owned.');
  }
  if (body.value === null || body.value === undefined) deleteAppSetting(appDir, key);
  else writeAppSetting(appDir, key, body.value);
  return sendJson(res, 200, { settings: readAppSettings(appDir) });
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
