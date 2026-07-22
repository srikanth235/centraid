/*
 * Version handshake (issue #289 / #468 K10 / #504 / #512).
 *
 * Pure core for desktop, web, CLI, and extension. On connect the client reads
 * `GET /centraid/_gateway/info` and judges **protocol version only**.
 * Product `version` is display metadata — product skew is never a refuse reason.
 */

import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_SCHEMA_EPOCH,
  GATEWAY_VERSION,
} from './version.js';
import {
  DEFAULT_GATEWAY_CAPABILITIES,
  isGatewayCapabilities,
  type GatewayCapabilities,
} from './capabilities.js';
import { ROUTES } from './routes.js';

export interface GatewayInfo {
  /** Product version (display only). */
  version: string;
  /**
   * Wire protocol version. Prefer this over schemaEpoch for new code.
   * Always present on payloads built by `buildGatewayInfoPayload`.
   */
  protocolVersion: number;
  /** Oldest protocol this peer still supports. */
  minSupportedProtocol: number;
  /**
   * Historical field; equals protocolVersion until vault epoch splits.
   * Still accepted as a fallback when protocolVersion is absent (older gateways).
   */
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
  | {
      ok: false;
      reason: 'unreachable' | 'malformed' | 'protocol_mismatch';
      detail: string;
    };

/**
 * Resolve protocol numbers from a gateway info payload.
 * Prefers protocolVersion; falls back to schemaEpoch for older gateways.
 */
export function readProtocolFromInfo(info: Record<string, unknown>): {
  protocolVersion: number | null;
  minSupportedProtocol: number | null;
} {
  const protocolRaw = info.protocolVersion ?? info.schemaEpoch;
  const protocolVersion =
    typeof protocolRaw === 'number' && Number.isSafeInteger(protocolRaw) ? protocolRaw : null;
  const minRaw = info.minSupportedProtocol;
  const minSupportedProtocol =
    typeof minRaw === 'number' && Number.isSafeInteger(minRaw) ? minRaw : protocolVersion; // old gateways: only speak current protocol
  return { protocolVersion, minSupportedProtocol };
}

/**
 * Mutual support window (CapVer-style):
 * - gateway protocol >= client minSupported
 * - client protocol >= gateway minSupported
 */
export function protocolsCompatible(opts: {
  localProtocol: number;
  localMin: number;
  peerProtocol: number;
  peerMin: number;
}): boolean {
  return opts.peerProtocol >= opts.localMin && opts.localProtocol >= opts.peerMin;
}

/** Parse + judge a `/centraid/_gateway/info` payload against the local protocol floor. */
export function judgeGatewayInfo(raw: unknown): HandshakeResult {
  if (raw === null || typeof raw !== 'object') {
    return { ok: false, reason: 'malformed', detail: 'gateway info was not an object' };
  }
  const info = raw as Record<string, unknown>;
  if (typeof info.version !== 'string') {
    return {
      ok: false,
      reason: 'malformed',
      detail: 'gateway info missing version string',
    };
  }
  const { protocolVersion, minSupportedProtocol } = readProtocolFromInfo(info);
  if (protocolVersion === null || minSupportedProtocol === null) {
    return {
      ok: false,
      reason: 'malformed',
      detail: 'gateway info missing protocolVersion (or schemaEpoch fallback)',
    };
  }

  const ok = protocolsCompatible({
    localProtocol: GATEWAY_PROTOCOL_VERSION,
    localMin: GATEWAY_MIN_PROTOCOL_VERSION,
    peerProtocol: protocolVersion,
    peerMin: minSupportedProtocol,
  });
  if (!ok) {
    return {
      ok: false,
      reason: 'protocol_mismatch',
      detail:
        `protocol incompatible: gateway protocol ${protocolVersion} ` +
        `(minSupported ${minSupportedProtocol}); this client is protocol ` +
        `${GATEWAY_PROTOCOL_VERSION} (minSupported ${GATEWAY_MIN_PROTOCOL_VERSION}). ` +
        'Update the older side. Product version is not used for this check.',
    };
  }

  const capabilities = isGatewayCapabilities(info.capabilities)
    ? info.capabilities
    : { ...DEFAULT_GATEWAY_CAPABILITIES };
  const schemaEpoch =
    typeof info.schemaEpoch === 'number' && Number.isSafeInteger(info.schemaEpoch)
      ? info.schemaEpoch
      : protocolVersion;

  return {
    ok: true,
    info: {
      version: info.version,
      protocolVersion,
      minSupportedProtocol,
      schemaEpoch,
      capabilities,
      ...(typeof info.instanceId === 'string' ? { instanceId: info.instanceId } : {}),
      ...(typeof info.startedAt === 'number' ? { startedAt: info.startedAt } : {}),
      ...(typeof info.uptimeMs === 'number' ? { uptimeMs: info.uptimeMs } : {}),
    },
  };
}

/**
 * Fetch + judge a gateway's `/centraid/_gateway/info`. Network failures and
 * non-200s become `unreachable`; a shape/protocol mismatch is surfaced so the
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
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
    schemaEpoch: GATEWAY_SCHEMA_EPOCH,
    instanceId: input.instanceId,
    startedAt: input.startedAt,
    uptimeMs: input.uptimeMs,
    capabilities: input.capabilities ?? { ...DEFAULT_GATEWAY_CAPABILITIES },
  };
}
