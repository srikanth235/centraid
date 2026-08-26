export interface GatewayAuth {
  baseUrl: string;
  gatewayId?: string;
  token?: string;
  /** undefined = gateway picks. */
  vaultId?: string;
  webControl?: boolean;
  iroh?: boolean;
  /** Explicit pairing consent for durable replica/outbox/cache state. */
  rememberDevice?: boolean;
}

export class GatewayClientError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GatewayClientError";
    this.code = code;
  }
}

export function authHeaders(
  token: string | undefined,
  contentType?: string
): Record<string, string> {
  const h: Record<string, string> = {};
  if (token) h.Authorization = `Bearer ${token}`;
  if (contentType) h["Content-Type"] = contentType;
  return h;
}

export function href(baseUrl: string, pathname: string): string {
  return new URL(pathname, `${baseUrl}/`).toString();
}

export const VAULT_HEADER = "x-centraid-vault";

/** Header wins over the shell's ambient default scope (#599). */
export function scopedAuthHeaders(
  token: string | undefined,
  scopeId: string | undefined,
  contentType?: string
): Record<string, string> {
  const h = authHeaders(token, contentType);
  if (scopeId) h[VAULT_HEADER] = scopeId;
  return h;
}

export const enc = encodeURIComponent;
