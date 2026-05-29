/*
 * Renderer-side HTTP client for the gateway's runtime/data plane.
 *
 * Thin-client pivot: the renderer talks to the active gateway directly
 * over HTTP with a Bearer token, instead of relaying each call through
 * the Electron main process. Main still owns the credential — it reads
 * the active gateway's `{ baseUrl, token }` from keychain-backed settings
 * and hands it over once via `getGatewayAuth()`; we cache it and refresh
 * on gateway switch. The local embedded gateway answers on loopback; a
 * remote gateway answers on its URL — identical wire protocol either way
 * (the local server now emits CORS for the `file://` renderer origin).
 *
 * This module ports the pure `fetch` methods that previously lived in
 * `main/*-client.ts` + `@centraid/builder-harness`'s `gateway-client`.
 * It grows one method-group per phase; this slice covers the app read
 * surface (schema / table-rows / query / logs / deregister / live URL).
 */

/** Auth resolved from main: normalized base URL + optional bearer token. */
interface GatewayAuth {
  baseUrl: string;
  token?: string;
}

let cachedAuth: Promise<GatewayAuth> | undefined;

function auth(): Promise<GatewayAuth> {
  if (!cachedAuth) cachedAuth = window.CentraidApi.getGatewayAuth();
  return cachedAuth;
}

/** Drop the cached auth so the next call re-reads it from main. */
export function resetGatewayAuthCache(): void {
  cachedAuth = undefined;
}

// Self-invalidate when the active gateway flips — the URL + token change,
// so the next request must re-resolve. Registered once at module load;
// `window.CentraidApi` is always present before renderer scripts run.
window.CentraidApi.onGatewayChanged(() => resetGatewayAuthCache());

/** Error carrying a coarse `code` the UI can branch on, like HarnessError. */
export class GatewayClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GatewayClientError';
    this.code = code;
  }
}

function authHeaders(token: string | undefined, contentType?: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

function href(baseUrl: string, pathname: string): string {
  return new URL(pathname, `${baseUrl}/`).toString();
}

async function doFetch(baseUrl: string, pathname: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(href(baseUrl, pathname), init);
  } catch (err) {
    throw new GatewayClientError(
      'gateway_unreachable',
      `Could not reach gateway at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function readJson<T>(res: Response, op: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new GatewayClientError(
        'auth_required',
        `${op}: gateway rejected request (HTTP ${res.status}). Check your gateway token in Settings.`,
      );
    }
    if (res.status === 404)
      throw new GatewayClientError('not_found', `${op}: ${text || res.statusText}`);
    if (res.status === 409)
      throw new GatewayClientError('conflict', `${op}: ${text || res.statusText}`);
    throw new GatewayClientError(
      'gateway_error',
      `${op} failed (HTTP ${res.status}): ${text || res.statusText}`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GatewayClientError('gateway_error', `${op} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

const enc = encodeURIComponent;

/** URL the renderer loads in an app iframe. */
export async function appLiveUrl(input: { id: string }): Promise<{ url: string }> {
  const { baseUrl } = await auth();
  return { url: href(baseUrl, `/centraid/${enc(input.id)}/`) };
}

/**
 * Live `data.sqlite` schema for the Cloud → Database panel. `undefined`
 * when the app isn't registered (404) or has no active version (503).
 */
export async function appSchema(input: { id: string }): Promise<CentraidAppSchema | undefined> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/schema`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (res.status === 404 || res.status === 503) {
    await res.body?.cancel().catch(() => {});
    return undefined;
  }
  return readJson<CentraidAppSchema>(res, 'fetch app schema');
}

/** One page of rows from a table/view; gateway caps `limit` at 200. */
export async function appTableRows(input: {
  id: string;
  table: string;
  limit?: number;
  offset?: number;
}): Promise<CentraidAppTableRows> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.offset !== undefined) params.set('offset', String(input.offset));
  const qs = params.toString();
  const res = await doFetch(
    baseUrl,
    `/centraid/_apps/${enc(input.id)}/data/${enc(input.table)}${qs ? `?${qs}` : ''}`,
    { method: 'GET', headers: authHeaders(token) },
  );
  return readJson<CentraidAppTableRows>(res, 'fetch table rows');
}

/** Run one SQL statement against the app's `data.sqlite`. */
export async function appQuery(input: {
  id: string;
  sql: string;
}): Promise<CentraidRunQueryResult> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/query`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify({ sql: input.sql }),
  });
  return readJson<CentraidRunQueryResult>(res, 'run query');
}

/** Newest-first tail of persistent handler logs. */
export async function appLogs(input: {
  id: string;
  limit?: number;
  sinceTs?: number;
  level?: CentraidLogLevel;
}): Promise<{ entries: CentraidLogEntry[] }> {
  const { baseUrl, token } = await auth();
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set('limit', String(input.limit));
  if (input.sinceTs !== undefined) params.set('sinceTs', String(input.sinceTs));
  if (input.level) params.set('level', input.level);
  const qs = params.toString();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}/logs${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  return readJson<{ entries: CentraidLogEntry[] }>(res, 'fetch app logs');
}

/** Remove an app from the registry. */
export async function deregisterApp(input: { id: string }): Promise<{ id: string }> {
  const { baseUrl, token } = await auth();
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(input.id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  return readJson<{ id: string }>(res, 'deregister');
}
