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
  /**
   * Shared-client Google OAuth courier is configured on this gateway.
   * Optional on the wire so pre-#526 gateways remain structurally valid;
   * clients interpret absence as false.
   */
  // COMPAT(assist-oauth-capability): added 2026-07-23; drop optionality when the protocol floor requires #526.
  assistOAuth?: boolean;
  /**
   * Native interactive automation turns and conversational revision.
   * Optional so clients connected to a pre-#541 gateway hide the composer.
   */
  // COMPAT(automation-turns-capability): added 2026-07-24; drop optionality when the protocol floor requires #541.
  automationTurns?: boolean;
}

/** Default capability surface for a modern loopback/daemon gateway. */
export const DEFAULT_GATEWAY_CAPABILITIES: GatewayCapabilities = Object.freeze({
  webSessions: true,
  devicePairing: true,
  tunnel: true,
  backupWal: true,
  assistOAuth: false,
  automationTurns: true,
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
    (c.assistOAuth === undefined || typeof c.assistOAuth === "boolean") &&
    (c.automationTurns === undefined || typeof c.automationTurns === "boolean")
  );
}
