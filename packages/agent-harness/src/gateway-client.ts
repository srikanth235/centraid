import type {
  AppSchema,
  AppTableRows,
  RunQueryResult,
  LogEntry,
  LogLevel,
} from '@centraid/openclaw-plugin';
import type { HarnessConfig, PublishResult } from './types.js';
import { HarnessError } from './types.js';

/**
 * Thin client over the openclaw-plugin HTTP surface for routes that the
 * desktop / mobile UIs need beyond uploading. All methods take the resolved
 * HarnessConfig (gatewayUrl + optional bearer token).
 */

export interface VersionRecord {
  versionId: string;
  sha256: string;
  declaredVersion?: string;
  uploadedAt: string;
  bytes: number;
  files: number;
  current?: boolean;
}

export interface AppRegistryRow {
  id: string;
  path: string;
  mode: 'uploaded' | 'path';
  registeredAt: string;
  crons: string[];
  cronStatus: Record<string, unknown>;
}

function url(config: HarnessConfig, pathname: string): string {
  return new URL(pathname, config.gatewayUrl).toString();
}

function authHeaders(config: HarnessConfig): Record<string, string> {
  return config.gatewayToken && config.gatewayToken.length > 0
    ? { Authorization: `Bearer ${config.gatewayToken}` }
    : {};
}

async function fetchOrThrow(
  config: HarnessConfig,
  href: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(href, init);
  } catch (err) {
    throw new HarnessError(
      'gateway_unreachable',
      `Could not reach gateway at ${config.gatewayUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function readJson<T>(res: Response, op: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new HarnessError(
        'auth_required',
        `${op}: gateway rejected request (HTTP ${res.status}). Configure your gateway token in Settings.`,
      );
    }
    if (res.status === 404) {
      throw new HarnessError('not_found', `${op}: ${text || res.statusText}`);
    }
    if (res.status === 409) {
      throw new HarnessError('conflict', `${op}: ${text || res.statusText}`);
    }
    throw new HarnessError(
      'gateway_error',
      `${op} failed (HTTP ${res.status}): ${text || res.statusText}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HarnessError(
      'gateway_error',
      `${op} returned non-JSON response: ${text.slice(0, 200)}`,
    );
  }
}

export async function listApps(config: HarnessConfig): Promise<AppRegistryRow[]> {
  const res = await fetchOrThrow(config, url(config, '/centraid/_apps'), {
    method: 'GET',
    headers: authHeaders(config),
  });
  return readJson<AppRegistryRow[]>(res, 'list apps');
}

export async function listVersions(
  config: HarnessConfig,
  appId: string,
): Promise<{ activeVersion?: string; versions: VersionRecord[] }> {
  const res = await fetchOrThrow(
    config,
    url(config, `/centraid/_apps/${encodeURIComponent(appId)}/versions`),
    { method: 'GET', headers: authHeaders(config) },
  );
  return readJson(res, 'list versions');
}

export async function activateVersion(
  config: HarnessConfig,
  appId: string,
  versionId: string,
): Promise<{ activeVersion: string }> {
  const res = await fetchOrThrow(
    config,
    url(config, `/centraid/_apps/${encodeURIComponent(appId)}/activate`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
      body: JSON.stringify({ versionId }),
    },
  );
  return readJson(res, 'activate version');
}

export async function deregisterApp(config: HarnessConfig, appId: string): Promise<{ id: string }> {
  const res = await fetchOrThrow(
    config,
    url(config, `/centraid/_apps/${encodeURIComponent(appId)}`),
    { method: 'DELETE', headers: authHeaders(config) },
  );
  return readJson(res, 'deregister');
}

/**
 * Fetch the live `data.sqlite` schema. Returns `undefined` when the app
 * isn't registered yet or has no active version (i.e. it's never been
 * published) — the agent treats both as "no live schema, write fresh
 * migrations".
 */
export async function fetchAppSchema(
  config: HarnessConfig,
  appId: string,
): Promise<AppSchema | undefined> {
  const href = url(config, `/centraid/_apps/${encodeURIComponent(appId)}/schema`);
  const res = await fetchOrThrow(config, href, {
    method: 'GET',
    headers: authHeaders(config),
  });
  if (res.status === 404 || res.status === 503 || res.status === 409) {
    // 404: app not registered. 503: no active version yet. 409: path-mode app.
    // All three legitimately mean "no live schema to inject".
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  return readJson<AppSchema>(res, 'fetch app schema');
}

/**
 * Page of rows from a table (or view) in the app's `data.sqlite`. The
 * gateway returns 404 if the table doesn't exist — surfaces as
 * `HarnessError('not_found')`.
 */
export async function fetchAppTableRows(
  config: HarnessConfig,
  appId: string,
  tableName: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<AppTableRows> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  const qs = params.toString();
  const href = url(
    config,
    `/centraid/_apps/${encodeURIComponent(appId)}/data/${encodeURIComponent(tableName)}${qs ? `?${qs}` : ''}`,
  );
  const res = await fetchOrThrow(config, href, { method: 'GET', headers: authHeaders(config) });
  return readJson<AppTableRows>(res, 'fetch table rows');
}

/**
 * Run a single SQL statement against the app's `data.sqlite`. Returns
 * either `{ kind: 'rows', columns, rows, durationMs }` for SELECT-style
 * statements or `{ kind: 'exec', rowsAffected, lastInsertRowid, durationMs }`
 * for INSERT / UPDATE / DELETE / DDL.
 *
 * Multi-statement input is rejected by the gateway with HTTP 400.
 */
export async function runAppQuery(
  config: HarnessConfig,
  appId: string,
  sql: string,
): Promise<RunQueryResult> {
  const href = url(config, `/centraid/_apps/${encodeURIComponent(appId)}/query`);
  const res = await fetchOrThrow(config, href, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(config) },
    body: JSON.stringify({ sql }),
  });
  return readJson<RunQueryResult>(res, 'run query');
}

/**
 * Tail of the app's persistent handler log. The gateway returns newest-
 * first, capped at 500. `sinceTs` is the polling-friendly tail anchor.
 */
export async function fetchAppLogs(
  config: HarnessConfig,
  appId: string,
  opts: { limit?: number; sinceTs?: number; level?: LogLevel } = {},
): Promise<{ entries: LogEntry[] }> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.sinceTs !== undefined) params.set('sinceTs', String(opts.sinceTs));
  if (opts.level) params.set('level', opts.level);
  const qs = params.toString();
  const href = url(
    config,
    `/centraid/_apps/${encodeURIComponent(appId)}/logs${qs ? `?${qs}` : ''}`,
  );
  const res = await fetchOrThrow(config, href, { method: 'GET', headers: authHeaders(config) });
  return readJson<{ entries: LogEntry[] }>(res, 'fetch app logs');
}

/** URL the renderer should use to load the app's index.html in an iframe. */
export function appLiveUrl(config: HarnessConfig, appId: string): string {
  return url(config, `/centraid/${encodeURIComponent(appId)}/`);
}

export type { PublishResult };
