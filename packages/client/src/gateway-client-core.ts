/* Renderer-side gateway HTTP client (#141). Own module so the data-plane
 * and editing clients do not form an import cycle. */

import { GatewayClientError, href, VAULT_HEADER } from "./gateway-auth.js";
import type { GatewayAuth } from "./gateway-auth.js";

export {
  authHeaders,
  enc,
  GatewayClientError,
  href,
  scopedAuthHeaders,
  VAULT_HEADER,
  type GatewayAuth,
} from "./gateway-auth.js";

declare global {
  interface Window {
    CentraidIroh?: {
      fetch: (pathname: string, init?: RequestInit) => Promise<Response>;
      url: (pathname: string) => Promise<string>;
    };
  }
}

let cachedAuth: Promise<GatewayAuth> | undefined;
let cachedClientSessionId: string | undefined;

export const CLIENT_SESSION_HEADER = "x-centraid-client-session";

/** Per-tab ceremony binding. Never an OAuth URL: the gateway records it beside state. */
export function clientSessionId(): string {
  if (cachedClientSessionId) return cachedClientSessionId;
  const storageKey = "centraid.oauth.client-session.v1";
  try {
    const saved = window.sessionStorage.getItem(storageKey);
    if (saved && /^[A-Za-z0-9_-]{32,128}$/u.test(saved)) {
      cachedClientSessionId = saved;
      return saved;
    }
  } catch {
    // sessionStorage denied — in-memory binding still protects this tab.
  }
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  cachedClientSessionId = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  try {
    window.sessionStorage.setItem(storageKey, cachedClientSessionId);
  } catch {
    // sessionStorage denied — in-memory id already set.
  }
  return cachedClientSessionId;
}

export function withClientSession(headers: HeadersInit): Headers {
  const out = new Headers(headers);
  out.set(CLIENT_SESSION_HEADER, clientSessionId());
  return out;
}

export function auth(): Promise<GatewayAuth> {
  if (!cachedAuth) cachedAuth = window.CentraidApi.getGatewayAuth();
  return cachedAuth;
}

export function resetGatewayAuthCache(): void {
  cachedAuth = undefined;
}

window.CentraidApi.onGatewayChanged(() => resetGatewayAuthCache());
// Vault switch (#289) keeps the gateway; only `x-centraid-vault` changes.
window.CentraidApi.onVaultChanged?.(() => resetGatewayAuthCache());

export async function doFetch(
  baseUrl: string,
  pathname: string,
  init: RequestInit
): Promise<Response> {
  const finalInit = await withVaultHeader(init);
  try {
    const gatewayAuth = await auth();
    if (gatewayAuth.iroh) {
      if (!window.CentraidIroh)
        throw new Error("Iroh browser transport is not installed.");
      return await window.CentraidIroh.fetch(pathname, finalInit);
    }
    const requestPath = gatewayAuth.webControl
      ? `/centraid/_web/control?path=${encodeURIComponent(pathname)}`
      : pathname;
    return await fetch(href(baseUrl, requestPath), {
      ...finalInit,
      credentials: gatewayAuth.webControl ? "include" : finalInit.credentials,
    });
  } catch (error) {
    throw new GatewayClientError(
      "gateway_unreachable",
      `Could not reach gateway at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`
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

/** Non-JSON body is not the gateway. Raw body is diagnostic, never user-facing. */
export function nonJsonError(
  op: string,
  status: number,
  text: string
): GatewayClientError {
  console.warn(
    `[centraid] ${op} returned a non-JSON body (HTTP ${status}):`,
    text.slice(0, 200)
  );
  return new GatewayClientError(
    "gateway_error",
    `${op}: unexpected response — the gateway may be starting up or unreachable.`
  );
}

export async function readJson<T>(res: Response, op: string): Promise<T> {
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new GatewayClientError(
        "auth_required",
        `${op}: gateway rejected the request (HTTP ${res.status}) — check your token in Settings.`
      );
    }
    if (res.status === 404)
      throw new GatewayClientError(
        "not_found",
        `${op}: ${text || res.statusText}`
      );
    if (res.status === 409)
      throw new GatewayClientError(
        "conflict",
        `${op}: ${text || res.statusText}`
      );
    throw new GatewayClientError(
      "gateway_error",
      `${op} failed (HTTP ${res.status}): ${text || res.statusText}`
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw nonJsonError(op, res.status, text);
  }
}
