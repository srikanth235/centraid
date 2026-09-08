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
  /** Experimental (v0). Optional + absent-tolerant; off hides surface only. */
  automations?: boolean;
  connectors?: boolean;
  /**
   * THE SEAT DOORS (#996, review sweep F1): a sanitised whole-file snapshot
   * and the log tail beside it. A seat gates on this rather than probing the
   * routes, because a 404 cannot distinguish "this gateway does not serve
   * seats" from "this gateway is older than the doors" — and the two call for
   * different answers on the phone.
   *
   * It is also what the phone's compatibility wall gates on since #996 wave 3.
   * The two words it used to gate on — `multiVaultReplica` and
   * `crossVaultPlacements` — described the mount plane, and a wall that names a
   * deleted mechanism tells a member to update a gateway for a feature neither
   * end has.
   */
  seatReplica?: boolean;
  /**
   * The locker key door (#996, R13). Separate from `seatReplica` on purpose:
   * a gateway can serve the whole file and still hold no locker key, and a
   * seat that conflates them shows a member "unreadable secret" where the
   * truthful answer is "this vault has no locker".
   */
  seatLockerKey?: boolean;
}

export const DEFAULT_GATEWAY_CAPABILITIES: GatewayCapabilities = Object.freeze({
  webSessions: true,
  devicePairing: true,
  tunnel: true,
  backupWal: true,
  assistOAuth: false,
  automationTurns: true,
  // Experimental features default OFF on a fresh gateway (v0).
  automations: false,
  connectors: false,
  // The snapshot and log-tail doors are SERVED (#996, W1). The locker key is
  // not: the route authenticates and answers `seat_locker_key_unavailable`
  // until W6 lands the key plane, and a seat has to be able to tell that from
  // a gateway too old to have the door at all.
  seatReplica: true,
  seatLockerKey: false,
});

/** Keys a gateway may omit. Absent reads as off — never a malformed handshake. */
export const OPTIONAL_GATEWAY_CAPABILITIES = [
  "automations",
  "connectors",
  "seatReplica",
  "seatLockerKey",
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
    // Optional flags: absent (old gateway) reads as off; a present
    // non-boolean is still a malformed map.
    (c.automations === undefined || typeof c.automations === "boolean") &&
    (c.connectors === undefined || typeof c.connectors === "boolean") &&
    (c.seatReplica === undefined || typeof c.seatReplica === "boolean") &&
    (c.seatLockerKey === undefined || typeof c.seatLockerKey === "boolean")
  );
}
