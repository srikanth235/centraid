// Version handshake (#289 / #468 K10 / #504 / #512): protocol-only judging;
// product skew is never a refuse reason.

import {
  DEFAULT_GATEWAY_CAPABILITIES,
  isGatewayCapabilities,
} from "./capabilities.js";
import type { GatewayCapabilities } from "./capabilities.js";
import { ROUTES } from "./routes.js";
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  GATEWAY_VERSION,
} from "./version.js";

export interface GatewayInfo {
  version: string;
  /** Wire protocol version. */
  protocolVersion: number;
  /** Oldest protocol this peer supports. */
  minSupportedProtocol: number;
  instanceId?: string;
  /** Feature capability map (C1). */
  capabilities: GatewayCapabilities;
  startedAt?: number;
  uptimeMs?: number;
  /**
   * Credential accepted for THIS request (#603)? Auth-gated fields are
   * silently absent otherwise; a bearer mismatch would read like "not ready".
   */
  authenticated?: boolean;
  /** COMPAT(#555): stable gateway transport identity, independent of its address. */
  endpointId?: string;
  /** COMPAT(#555): dial address, valid-credential callers only (#568 C); never persist as identity. */
  endpointTicket?: string;
}

export type HandshakeResult =
  | { ok: true; info: GatewayInfo }
  | {
      ok: false;
      reason: "unreachable" | "malformed" | "protocol_mismatch";
      detail: string;
    };

export function readProtocolFromInfo(info: Record<string, unknown>): {
  protocolVersion: number | null;
  minSupportedProtocol: number | null;
} {
  const protocolRaw = info.protocolVersion;
  const protocolVersion =
    typeof protocolRaw === "number" && Number.isSafeInteger(protocolRaw)
      ? protocolRaw
      : null;
  const minRaw = info.minSupportedProtocol;
  const minSupportedProtocol =
    typeof minRaw === "number" && Number.isSafeInteger(minRaw)
      ? minRaw
      : protocolVersion;
  return { protocolVersion, minSupportedProtocol };
}

export function protocolsCompatible(opts: {
  localProtocol: number;
  localMin: number;
  peerProtocol: number;
  peerMin: number;
}): boolean {
  return (
    opts.peerProtocol >= opts.localMin && opts.localProtocol >= opts.peerMin
  );
}

export function judgeGatewayInfo(raw: unknown): HandshakeResult {
  if (raw === null || typeof raw !== "object") {
    return {
      ok: false,
      reason: "malformed",
      detail: "gateway info was not an object",
    };
  }
  const info = raw as Record<string, unknown>;
  if (typeof info.version !== "string") {
    return {
      ok: false,
      reason: "malformed",
      detail: "gateway info missing version string",
    };
  }
  const { protocolVersion, minSupportedProtocol } = readProtocolFromInfo(info);
  if (protocolVersion === null || minSupportedProtocol === null) {
    return {
      ok: false,
      reason: "malformed",
      detail: "gateway info missing protocolVersion",
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
      reason: "protocol_mismatch",
      detail:
        `protocol incompatible: gateway protocol ${protocolVersion} ` +
        `(minSupported ${minSupportedProtocol}); this client is protocol ` +
        `${GATEWAY_PROTOCOL_VERSION} (minSupported ${GATEWAY_MIN_PROTOCOL_VERSION}). ` +
        "Update the older side. Product version is not used for this check.",
    };
  }

  if (!isGatewayCapabilities(info.capabilities)) {
    return {
      ok: false,
      reason: "malformed",
      detail: "gateway info missing capabilities",
    };
  }

  return {
    ok: true,
    info: {
      version: info.version,
      protocolVersion,
      minSupportedProtocol,
      capabilities: info.capabilities,
      ...(typeof info.instanceId === "string"
        ? { instanceId: info.instanceId }
        : {}),
      ...(typeof info.startedAt === "number"
        ? { startedAt: info.startedAt }
        : {}),
      ...(typeof info.uptimeMs === "number" ? { uptimeMs: info.uptimeMs } : {}),
      ...(typeof info.authenticated === "boolean"
        ? { authenticated: info.authenticated }
        : {}),
      ...(typeof info.endpointId === "string"
        ? { endpointId: info.endpointId }
        : {}),
      ...(typeof info.endpointTicket === "string"
        ? { endpointTicket: info.endpointTicket }
        : {}),
    },
  };
}

/**
 * Fetch + judge a gateway's `/centraid/_gateway/info`; network failures and
 * non-200s become `unreachable`; `fetchImpl` injectable (#532 owns the pure
 * judges).
 */
// Stryker disable all
export async function handshakeGateway(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<HandshakeResult> {
  let res: Response;
  try {
    res = await fetchImpl(
      new URL(ROUTES.gatewayInfo, `${baseUrl}/`).toString(),
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }
    );
  } catch (error) {
    return {
      ok: false,
      reason: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!res.ok) {
    return { ok: false, reason: "unreachable", detail: `HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      ok: false,
      reason: "malformed",
      detail: "gateway info was not JSON",
    };
  }
  return judgeGatewayInfo(body);
}

/** Build the info payload the gateway route should emit. */
export function buildGatewayInfoPayload(input: {
  instanceId: string;
  startedAt: number;
  uptimeMs: number;
  authenticated: boolean;
  endpointId?: string;
  endpointTicket?: string;
  capabilities?: GatewayCapabilities;
}): GatewayInfo {
  return {
    version: GATEWAY_VERSION,
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    minSupportedProtocol: GATEWAY_MIN_PROTOCOL_VERSION,
    instanceId: input.instanceId,
    startedAt: input.startedAt,
    uptimeMs: input.uptimeMs,
    authenticated: input.authenticated,
    ...(input.endpointId === undefined ? {} : { endpointId: input.endpointId }),
    ...(input.endpointTicket === undefined
      ? {}
      : { endpointTicket: input.endpointTicket }),
    capabilities: input.capabilities ?? { ...DEFAULT_GATEWAY_CAPABILITIES },
  };
}
