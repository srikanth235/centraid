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

/**
 * Auth resolved from main: normalized base URL + optional bearer token +
 * the vault this client addresses on the active gateway (issue #289 — the
 * client owns its vault pointer; the gateway no longer holds one).
 */
export interface GatewayAuth {
  baseUrl: string;
  /** Stable gateway/profile identity; unlike baseUrl it survives transport re-dials. */
  gatewayId?: string;
  token?: string;
  /** The `x-centraid-vault` header value; undefined = let the gateway pick. */
  vaultId?: string;
  /** Browser shell requests are tunneled through an Origin-bound HttpOnly control session. */
  webControl?: boolean;
  /** Browser requests use the page's Iroh/WASM transport instead of HTTP. */
  iroh?: boolean;
  /** Explicit pairing consent for durable replica/outbox/cache state. */
  rememberDevice?: boolean;
}

declare global {
  interface Window {
    CentraidIroh?: {
      fetch(pathname: string, init?: RequestInit): Promise<Response>;
      url(pathname: string): Promise<string>;
    };
  }
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
// A vault switch (issue #289) keeps the gateway but changes the addressed
// vault — the URL + token are unchanged, only the `x-centraid-vault` header,
// so re-resolving auth is all that's needed (no wholesale reload).
window.CentraidApi.onVaultChanged?.(() => resetGatewayAuthCache());

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

/** The canonical vault-addressing header (mirrors the gateway's constant). */
export const VAULT_HEADER = 'x-centraid-vault';

/** Mint a one-time generated-app launch URL when the host uses browser sessions. */
export async function appSessionUrl(
  appId: string,
  directPath: string,
  draftSessionId?: string,
): Promise<string> {
  const capabilities = await window.CentraidApi.getHostCapabilities?.();
  const { baseUrl, token, iroh } = await auth();
  if (!capabilities?.appSessions) {
    return iroh && window.CentraidIroh
      ? window.CentraidIroh.url(directPath)
      : href(baseUrl, directPath);
  }
  const res = await doFetch(baseUrl, `/centraid/_apps/${enc(appId)}/web-session`, {
    method: 'POST',
    headers: authHeaders(token, 'application/json'),
    body: JSON.stringify(draftSessionId ? { draftSessionId } : {}),
  });
  const out = await readJson<{ launchPath: string }>(res, 'open browser app session');
  return iroh && window.CentraidIroh
    ? window.CentraidIroh.url(out.launchPath)
    : href(baseUrl, out.launchPath);
}

export async function doFetch(
  baseUrl: string,
  pathname: string,
  init: RequestInit,
): Promise<Response> {
  // Stamp the addressed vault on every request (issue #289). The caller
  // resolved `auth()` just above, so the cached promise is settled — read
  // the vault id off it and add the header unless the caller set one. This
  // one choke point saves threading the id through every call site.
  const finalInit = await withVaultHeader(init);
  try {
    const gatewayAuth = await auth();
    if (gatewayAuth.iroh) {
      if (!window.CentraidIroh) throw new Error('Iroh browser transport is not installed.');
      return await window.CentraidIroh.fetch(pathname, finalInit);
    }
    const requestPath = gatewayAuth.webControl
      ? `/centraid/_web/control?path=${encodeURIComponent(pathname)}`
      : pathname;
    return await fetch(href(baseUrl, requestPath), {
      ...finalInit,
      credentials: gatewayAuth.webControl ? 'include' : finalInit.credentials,
    });
  } catch (err) {
    throw new GatewayClientError(
      'gateway_unreachable',
      `Could not reach gateway at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function withVaultHeader(init: RequestInit): Promise<RequestInit> {
  let vaultId: string | undefined;
  try {
    vaultId = (await auth()).vaultId;
  } catch {
    vaultId = undefined;
  }
  if (!vaultId) return init;
  const headers = new Headers(init.headers as HeadersInit | undefined);
  if (!headers.has(VAULT_HEADER)) headers.set(VAULT_HEADER, vaultId);
  return { ...init, headers };
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
