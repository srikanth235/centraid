/*
 * Version handshake (issue #289 / #468 K10 / #504).
 *
 * Pure core for desktop, web, CLI, and extension. On connect the client reads
 * `GET /centraid/_gateway/info` and compares BOTH the software version and the
 * schema epoch. v0 policy is exact-match-or-refuse.
 */

import { GATEWAY_SCHEMA_EPOCH, GATEWAY_VERSION } from './version.js';
import {
  DEFAULT_GATEWAY_CAPABILITIES,
  isGatewayCapabilities,
  type GatewayCapabilities,
} from './capabilities.js';
import { ROUTES } from './routes.js';

export interface GatewayInfo {
  version: string;
  schemaEpoch: number;
  /**
   * Per-process instance id (issue #351's `GatewayInstanceLease`).
   * Optional — older gateways omit it.
   */
  instanceId?: string;
  /**
   * Feature capability map (C1). Optional on the wire for older gateways;
   * judges fill defaults so clients detect features in one place.
   */
  capabilities?: GatewayCapabilities;
  /** Process start epoch ms — additive runtime clock. */
  startedAt?: number;
  /** Process uptime ms — additive runtime clock. */
  uptimeMs?: number;
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
  if (info.version !== GATEWAY_VERSION || info.schemaEpoch !== GATEWAY_SCHEMA_EPOCH) {
    return {
      ok: false,
      reason: 'version_mismatch',
      detail:
        `gateway is v${info.version} (epoch ${info.schemaEpoch}); ` +
        `this app expects v${GATEWAY_VERSION} (epoch ${GATEWAY_SCHEMA_EPOCH}). ` +
        'Update both to the same version.',
    };
  }
  const capabilities = isGatewayCapabilities(info.capabilities)
    ? info.capabilities
    : { ...DEFAULT_GATEWAY_CAPABILITIES };
  return {
    ok: true,
    info: {
      version: info.version,
      schemaEpoch: info.schemaEpoch,
      capabilities,
      ...(typeof info.instanceId === 'string' ? { instanceId: info.instanceId } : {}),
      ...(typeof info.startedAt === 'number' ? { startedAt: info.startedAt } : {}),
      ...(typeof info.uptimeMs === 'number' ? { uptimeMs: info.uptimeMs } : {}),
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
    res = await fetchImpl(new URL(ROUTES.gatewayInfo, `${baseUrl}/`).toString(), {
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

/** Build the info payload the gateway route should emit. */
export function buildGatewayInfoPayload(input: {
  instanceId: string;
  startedAt: number;
  uptimeMs: number;
  capabilities?: GatewayCapabilities;
}): GatewayInfo {
  return {
    version: GATEWAY_VERSION,
    schemaEpoch: GATEWAY_SCHEMA_EPOCH,
    instanceId: input.instanceId,
    startedAt: input.startedAt,
    uptimeMs: input.uptimeMs,
    capabilities: input.capabilities ?? { ...DEFAULT_GATEWAY_CAPABILITIES },
  };
}
