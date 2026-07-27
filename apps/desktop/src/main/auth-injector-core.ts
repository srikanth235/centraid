/**
 * Auth-injector pure core — header injection + CSP frame-ancestors relaxation.
 *
 * Electron-free so unit tests cover the request/response rewrite rules without
 * mocking `session.webRequest`. `auth-injector.ts` wires these onto the
 * renderer session; this module owns only the pure transforms.
 */

export interface AuthInjectorSnapshot {
  gatewayOrigin: string;
  gatewayToken: string;
  gatewayVaultId: string;
}

/** The vault-addressing header (mirrors the gateway's constant, #289). */
export const VAULT_HEADER = 'x-centraid-vault';

/** True when `url` is same-origin with the configured gateway. */
export function matchesGateway(url: string, gatewayOrigin: string): boolean {
  try {
    return new URL(url).origin === gatewayOrigin;
  } catch {
    return false;
  }
}

/**
 * Inject Authorization + vault headers when the request targets the gateway
 * and the headers are not already set. Returns the original map when the
 * snapshot has no origin/token (no-op path).
 */
export function applyOutgoingAuthHeaders(
  requestHeaders: Record<string, string>,
  snapshot: AuthInjectorSnapshot,
  url: string,
): Record<string, string> {
  if (!snapshot.gatewayOrigin || !snapshot.gatewayToken) return requestHeaders;
  if (!matchesGateway(url, snapshot.gatewayOrigin)) return requestHeaders;
  const headers = { ...requestHeaders };
  const hasAuth = Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
  if (!hasAuth) {
    headers.Authorization = `Bearer ${snapshot.gatewayToken}`;
  }
  if (snapshot.gatewayVaultId) {
    const hasVault = Object.keys(headers).some((k) => k.toLowerCase() === VAULT_HEADER);
    if (!hasVault) headers[VAULT_HEADER] = snapshot.gatewayVaultId;
  }
  return headers;
}

// CSP directives are case-insensitive, separated by `;`. The renderer is
// trusted to frame the gateway, so we strip `frame-ancestors` rather than
// trying to allowlist the file:// origin (which CSP matches awkwardly).
export function relaxFrameAncestors(
  responseHeaders: Record<string, string[] | string>,
): Record<string, string[] | string> {
  const out: Record<string, string[] | string> = {};
  for (const [name, value] of Object.entries(responseHeaders)) {
    const lower = name.toLowerCase();
    if (lower === 'content-security-policy' || lower === 'content-security-policy-report-only') {
      const values = Array.isArray(value) ? value : [value];
      out[name] = values.map(stripFrameAncestors).filter((v) => v.length > 0);
      continue;
    }
    if (lower === 'x-frame-options') continue;
    out[name] = value;
  }
  return out;
}

export function stripFrameAncestors(policy: string): string {
  return policy
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !/^frame-ancestors\b/iu.test(d))
    .join('; ');
}

/**
 * When the snapshot has a gateway origin and the URL matches, rewrite CSP;
 * otherwise pass headers through unchanged.
 */
export function applyIncomingFrameRelaxation(
  responseHeaders: Record<string, string[] | string> | undefined,
  snapshot: AuthInjectorSnapshot | null,
  url: string,
): Record<string, string[] | string> | undefined {
  if (!snapshot || !snapshot.gatewayOrigin) return responseHeaders;
  if (!matchesGateway(url, snapshot.gatewayOrigin)) return responseHeaders;
  return relaxFrameAncestors(responseHeaders ?? {});
}
