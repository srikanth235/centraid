/*
 * Capability map for C1 feature detection (issue #504 / docs/protocol.md).
 *
 * The map is structural (C3): no transforms. Clients detect capabilities in
 * exactly one place via `judgeGatewayInfo` / the info response — not re-derived
 * per screen.
 */

/** Named feature flags the gateway may advertise on `/centraid/_gateway/info`. */
export interface GatewayCapabilities {
  /** Origin-bound HttpOnly web control + app sessions (PWA). */
  webSessions: boolean;
  /** Device pairing + per-device HTTP tokens. */
  devicePairing: boolean;
  /** Tunnel / relay plane available from this process. */
  tunnel: boolean;
  /** Continuous WAL backup shipper surface. */
  backupWal: boolean;
  /** Shared-client Google OAuth courier is configured on this gateway. */
  assistOAuth: boolean;
  /** Native interactive automation turns and conversational revision. */
  automationTurns: boolean;
  /** One authenticated stream may carry changes for several mounted vaults. */
  multiVaultReplica: boolean;
  /** Idempotent cross-vault add/move placement intents are available. */
  crossVaultPlacements: boolean;
}

/** Default capability surface for a modern loopback/daemon gateway. */
export const DEFAULT_GATEWAY_CAPABILITIES: GatewayCapabilities = Object.freeze({
  webSessions: true,
  devicePairing: true,
  tunnel: true,
  backupWal: true,
  assistOAuth: false,
  automationTurns: true,
  multiVaultReplica: true,
  crossVaultPlacements: true,
});

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
    typeof c.crossVaultPlacements === "boolean"
  );
}
