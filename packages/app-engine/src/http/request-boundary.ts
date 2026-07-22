/**
 * Loopback HTTP request-boundary checks (issue #504 batch 0).
 *
 * Host allowlist closes DNS rebinding against the local control plane.
 * CORS distinguishes Bearer (no ambient credentials) from cookie/session
 * paths so we never reflect an arbitrary Origin with
 * `Access-Control-Allow-Credentials: true`.
 */

/** Hostnames always accepted on the loopback control plane. */
export const DEFAULT_ALLOWED_HOSTNAMES: readonly string[] = Object.freeze([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
]);

/**
 * Extract the hostname from an HTTP Host header value (optional port).
 * Returns undefined when the header is missing or malformed.
 */
export function hostnameFromHostHeader(
  hostHeader: string | string[] | undefined,
): string | undefined {
  if (hostHeader === undefined) return undefined;
  const raw = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (typeof raw !== 'string') return undefined;
  const host = raw.trim();
  if (host === '') return undefined;

  // IPv6 with brackets: `[::1]:8080` or `[::1]`.
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return undefined;
    const hostname = host.slice(0, end + 1);
    const rest = host.slice(end + 1);
    if (rest !== '' && !/^:\d+$/.test(rest)) return undefined;
    return hostname.toLowerCase();
  }

  // hostname or hostname:port (IPv4 / DNS). Reject bare IPv6 without brackets
  // that still contains multiple colons — those must use the bracket form.
  const colon = host.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(host.slice(colon + 1))) {
    return host.slice(0, colon).toLowerCase();
  }
  if (host.includes(':')) return undefined;
  return host.toLowerCase();
}

/**
 * True when the Host header names a loopback form or an explicitly configured
 * extra hostname. Missing/malformed Host is refused (DNS-rebinding posture).
 */
export function isAllowedHostHeader(
  hostHeader: string | string[] | undefined,
  extraAllowedHostnames: readonly string[] = [],
): boolean {
  const hostname = hostnameFromHostHeader(hostHeader);
  if (hostname === undefined) return false;
  for (const allowed of DEFAULT_ALLOWED_HOSTNAMES) {
    if (hostname === allowed) return true;
  }
  for (const allowed of extraAllowedHostnames) {
    if (hostname === allowed.trim().toLowerCase()) return true;
  }
  return false;
}

export interface CorsDecision {
  /** Value for Access-Control-Allow-Origin, or null to omit the header. */
  allowOrigin: string | null;
  /** Whether to set Access-Control-Allow-Credentials: true. */
  credentials: boolean;
}

export interface DecideCorsInput {
  /** Request Origin header (raw). */
  origin: string | string[] | undefined;
  /**
   * Origins allowed for credentialed CORS — typically bound shell origins
   * from control/app sessions. Empty is fine for Bearer-only embeds.
   */
  credentialedOrigins: readonly string[];
  /**
   * True when the request presents Bearer intent: an Authorization: Bearer
   * value, or an OPTIONS preflight that lists `authorization` in
   * Access-Control-Request-Headers. Bearer is not ambient; possession of the
   * token is the trust signal, so credentialed CORS for that Origin is safe.
   */
  bearerAuthIntent: boolean;
}

/**
 * Decide CORS headers for one request.
 *
 * - No Origin / `null` (file:// renderer): `*` without credentials.
 * - Origin on the credentialed allowlist, or Bearer intent: reflect Origin
 *   with credentials (PWA shell + desktop Bearer clients that need Set-Cookie).
 * - Foreign Origin without Bearer intent: `*` without credentials — never
 *   reflect the attacker origin with credentials (cookie ambient abuse).
 */
export function decideCors(input: DecideCorsInput): CorsDecision {
  const raw = input.origin;
  if (raw === undefined || Array.isArray(raw)) {
    return { allowOrigin: '*', credentials: false };
  }
  if (raw === 'null' || raw === '') {
    return { allowOrigin: '*', credentials: false };
  }

  if (input.credentialedOrigins.includes(raw) || input.bearerAuthIntent) {
    return { allowOrigin: raw, credentials: true };
  }

  // Foreign origin, cookie/ambient path only: never pair a reflected Origin
  // with credentials. `*` cannot be used with credentials mode, so a
  // cross-origin page that rides same-site cookies cannot read the body.
  return { allowOrigin: '*', credentials: false };
}

/** Detect Bearer auth intent from request headers (including CORS preflight). */
export function hasBearerAuthIntent(
  authorization: string | string[] | undefined,
  accessControlRequestHeaders: string | string[] | undefined,
): boolean {
  const auth = Array.isArray(authorization) ? authorization[0] : authorization;
  if (typeof auth === 'string' && /^Bearer\s+\S+/i.test(auth.trim())) return true;

  const acrh = Array.isArray(accessControlRequestHeaders)
    ? accessControlRequestHeaders.join(',')
    : accessControlRequestHeaders;
  if (typeof acrh !== 'string') return false;
  return acrh
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .includes('authorization');
}
