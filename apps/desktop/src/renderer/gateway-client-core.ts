/*
 * Shared infrastructure for the renderer-side gateway HTTP client
 * (issue #141). The data-plane methods (`gateway-client.ts`) and the
 * editing/lifecycle methods (`gateway-client-editing.ts`) both build on
 * this: auth resolution + caching, the bearer-header helper, the fetch
 * wrapper, and the JSON/error reader. Kept in its own dependency-free
 * module so the two consumers don't form an import cycle.
 *
 * Thin-client pivot: the renderer talks to the active gateway directly
 * over HTTP with a Bearer token. Main owns the credential — it reads the
 * active gateway's `{ baseUrl, token }` from keychain-backed settings and
 * hands it over once via `getGatewayAuth()`; we cache it and refresh on
 * gateway switch. Local embedded gateway answers on loopback; a remote
 * one on its URL — identical wire protocol (the local server emits CORS
 * for the `file://` renderer origin).
 */

/** Auth resolved from main: normalized base URL + optional bearer token. */
export interface GatewayAuth {
  baseUrl: string;
  token?: string;
}

let cachedAuth: Promise<GatewayAuth> | undefined;

export function auth(): Promise<GatewayAuth> {
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

export function authHeaders(
  token: string | undefined,
  contentType?: string,
): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (contentType) h['Content-Type'] = contentType;
  return h;
}

export function href(baseUrl: string, pathname: string): string {
  return new URL(pathname, `${baseUrl}/`).toString();
}

export async function doFetch(
  baseUrl: string,
  pathname: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(href(baseUrl, pathname), init);
  } catch (err) {
    throw new GatewayClientError(
      'gateway_unreachable',
      `Could not reach gateway at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function readJson<T>(res: Response, op: string): Promise<T> {
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

export const enc = encodeURIComponent;
