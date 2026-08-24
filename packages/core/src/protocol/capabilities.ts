/*
 * Capability map for C1 feature detection (#504 / docs/protocol.md).
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
  /**
   * Experimental gate (v0 early feedback): the automations surface —
   * lifecycle, runs feed, webhook ingress, cron scheduler — is enabled on
   * this gateway. Optional + absent-tolerant: a gateway that predates the
   * flag reads as off. Off hides surface only; durable data stays intact.
   */
  automations?: boolean;
  /**
   * Experimental gate (v0 early feedback): the provider connectors surface
   * (connection health/configure, PKCE consent ceremony) is enabled on this
   * gateway. Optional + absent-tolerant, same contract as `automations`.
   */
  connectors?: boolean;
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
  // Experimental features default OFF on a fresh gateway (v0); the owner
  // opts in via prefs or CENTRAID_EXPERIMENTAL.
  automations: false,
  connectors: false,
});

/**
 * Capability keys a gateway may omit (experimental gates added after the
 * required set froze). Absent reads as off — never a malformed handshake.
 */
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
    // Optional experimental flags: absent (old gateway) reads as off, but a
    // present non-boolean is still a malformed map.
    (c.automations === undefined || typeof c.automations === "boolean") &&
    (c.connectors === undefined || typeof c.connectors === "boolean")
  );
}
