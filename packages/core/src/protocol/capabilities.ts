/*
 * Capability map for C1 feature detection (#504 / docs/protocol.md).
 * Structural (C3): no transforms. Detect via `judgeGatewayInfo` / the info
 * response — not re-derived per screen.
 */

export interface GatewayCapabilities {
  webSessions: boolean;
  devicePairing: boolean;
  tunnel: boolean;
  backupWal: boolean;
  assistOAuth: boolean;
  automationTurns: boolean;
  multiVaultReplica: boolean;
  crossVaultPlacements: boolean;
  /** Experimental (v0). Optional + absent-tolerant; off hides surface only. */
  automations?: boolean;
  connectors?: boolean;
}

export const DEFAULT_GATEWAY_CAPABILITIES: GatewayCapabilities = Object.freeze({
  webSessions: true,
  devicePairing: true,
  tunnel: true,
  backupWal: true,
  assistOAuth: false,
  automationTurns: true,
  multiVaultReplica: true,
  crossVaultPlacements: true,
  // Experimental features default OFF on a fresh gateway (v0).
  automations: false,
  connectors: false,
});

/** Keys a gateway may omit. Absent reads as off — never a malformed handshake. */
export const OPTIONAL_GATEWAY_CAPABILITIES = [
  "automations",
  "connectors",
] as const;

export function isGatewayCapabilities(
  value: unknown
): value is GatewayCapabilities {
  if (value === null || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.webSessions === "boolean" &&
    typeof c.devicePairing === "boolean" &&
    typeof c.tunnel === "boolean" &&
    typeof c.backupWal === "boolean" &&
    typeof c.assistOAuth === "boolean" &&
    typeof c.automationTurns === "boolean" &&
    typeof c.multiVaultReplica === "boolean" &&
    typeof c.crossVaultPlacements === "boolean" &&
    // Optional flags: absent (old gateway) reads as off; a present
    // non-boolean is still a malformed map.
    (c.automations === undefined || typeof c.automations === "boolean") &&
    (c.connectors === undefined || typeof c.connectors === "boolean")
  );
}
