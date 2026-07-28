/*
 * Platform-neutral gateway auth primitives: the resolved-auth shape, the
 * coarse-coded error, the bearer-header helper and URL utilities. Split out of
 * `gateway-client-core.ts` (which stays browser-only — it touches `window` and
 * registers module-load listeners) so React Native replica code can reuse the
 * wire contract without dragging the DOM transport in.
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

/**
 * Bearer headers that name their target space EXPLICITLY (issue #599).
 *
 * `doFetch`'s `withVaultHeader` only fills {@link VAULT_HEADER} when the caller
 * left it unset, so a header stamped here wins over the shell's internal
 * default-scope pointer. Every flow that must be pinned to one space for its
 * whole life — a conversation, an app creation, an install — builds its headers
 * through this rather than relying on whatever the shell happens to point at.
 * `scopeId` omitted degrades to plain {@link authHeaders} (the ambient default).
 */
export function scopedAuthHeaders(
  token: string | undefined,
  scopeId: string | undefined,
  contentType?: string,
): Record<string, string> {
  const h = authHeaders(token, contentType);
  if (scopeId) h[VAULT_HEADER] = scopeId;
  return h;
}

export const enc = encodeURIComponent;
