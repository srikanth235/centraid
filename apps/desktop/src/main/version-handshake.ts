/*
 * Version handshake (issue #289 decision 8).
 *
 * A local gateway is in lockstep with the app that embeds it; a VPS daemon
 * serving several desktops is not. On connect the client reads
 * `GET /centraid/_gateway/info` and compares BOTH the software version and
 * the schema epoch against what it was built against. v0 policy is
 * exact-match-or-refuse (pre-release, no compat guarantees), so the first
 * skewed upgrade fails loudly instead of producing undebuggable weirdness.
 *
 * These constants MUST track `packages/gateway/src/version.ts`; the desktop
 * pins them so it can judge a remote gateway it did not build.
 */

/** The gateway software version this desktop build expects. */
export const EXPECTED_GATEWAY_VERSION = '0.1.0';

/** The vault schema epoch this desktop build expects. */
export const EXPECTED_SCHEMA_EPOCH = 1;

export interface GatewayInfo {
  version: string;
  schemaEpoch: number;
  /**
   * Per-process instance id (issue #351's `GatewayInstanceLease`, surfaced
   * on `/centraid/_gateway/info` since issue #382's connectivity test wants
   * it to detect a gateway swap-under-it). Optional — older gateways omit
   * it, and it plays no part in the version/schemaEpoch judgment below.
   */
  instanceId?: string;
}

export type HandshakeResult =
  | { ok: true; info: GatewayInfo }
  | { ok: false; reason: 'unreachable' | 'malformed' | 'version_mismatch'; detail: string };

/** Parse + judge a `/centraid/_gateway/info` payload against the pinned pair. */
export function judgeGatewayInfo(raw: unknown): HandshakeResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'malformed', detail: 'gateway info was not an object' };
  }
  const info = raw as Record<string, unknown>;
  if (typeof info.version !== 'string' || typeof info.schemaEpoch !== 'number') {
    return {
      ok: false,
      reason: 'malformed',
      detail: 'gateway info missing version or schemaEpoch',
    };
  }
  if (info.version !== EXPECTED_GATEWAY_VERSION || info.schemaEpoch !== EXPECTED_SCHEMA_EPOCH) {
    return {
      ok: false,
      reason: 'version_mismatch',
      detail:
        `gateway is v${info.version} (epoch ${info.schemaEpoch}); ` +
        `this app expects v${EXPECTED_GATEWAY_VERSION} (epoch ${EXPECTED_SCHEMA_EPOCH}). ` +
        'Update both to the same version.',
    };
  }
  return {
    ok: true,
    info: {
      version: info.version,
      schemaEpoch: info.schemaEpoch,
      ...(typeof info.instanceId === 'string' ? { instanceId: info.instanceId } : {}),
    },
  };
}

/**
 * Fetch + judge a gateway's `/centraid/_gateway/info`. Network failures and
 * non-200s become `unreachable`; a shape/version mismatch is surfaced so the
 * switcher can badge the pair. `fetchImpl` is injectable for tests.
 */
export async function handshakeGateway(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<HandshakeResult> {
  let res: Response;
  try {
    res = await fetchImpl(new URL('/centraid/_gateway/info', `${baseUrl}/`).toString(), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  } catch (err) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!res.ok) {
    return { ok: false, reason: 'unreachable', detail: `HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: 'malformed', detail: 'gateway info was not JSON' };
  }
  return judgeGatewayInfo(body);
}
