import { isGatewayCapabilities } from "@centraid/client/replica/native";
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  judgeGatewayInfo,
  readProtocolFromInfo,
} from "@centraid/core/protocol";

export type MobileCompatibilityDisposition =
  | "update-gateway"
  | "update-app"
  | "reconnect";

export const MOBILE_GATEWAY_UPDATE_MESSAGE =
  "This mobile version needs the current protocol and a gateway that serves the whole vault to this phone.";
export const MOBILE_APP_UPDATE_MESSAGE =
  "Mobile updates are store-only — update from the App Store or Google Play.";
export const MOBILE_GATEWAY_RECONNECT_MESSAGE =
  "Reconnect to the desktop once to verify it supports this mobile offline version.";

export const MOBILE_COMPATIBILITY_WALL_COPY: Record<
  MobileCompatibilityDisposition,
  { title: string; body: string; action: string }
> = {
  "update-gateway": {
    title: "Update the gateway",
    body: MOBILE_GATEWAY_UPDATE_MESSAGE,
    action: "I updated it — retry",
  },
  "update-app": {
    title: "Update the mobile app",
    body: MOBILE_APP_UPDATE_MESSAGE,
    action: "I updated it — retry",
  },
  reconnect: {
    title: "Reconnect once",
    body: MOBILE_GATEWAY_RECONNECT_MESSAGE,
    action: "Retry connection",
  },
};

export class MobileGatewayCompatibilityError extends Error {
  constructor(readonly disposition: MobileCompatibilityDisposition) {
    super(
      disposition === "update-app"
        ? MOBILE_APP_UPDATE_MESSAGE
        : disposition === "update-gateway"
          ? MOBILE_GATEWAY_UPDATE_MESSAGE
          : MOBILE_GATEWAY_RECONNECT_MESSAGE
    );
    this.name = "MobileGatewayCompatibilityError";
  }
}

/**
 * THE WALL GATES ON THE SEAT DOORS (#996 wave 3, review sweep F1).
 *
 * It used to gate on `multiVaultReplica` and `crossVaultPlacements` — two
 * words describing the mount plane, which is deleted. A wall that names a
 * mechanism neither end has tells a member to update a gateway for a feature
 * that no longer exists.
 *
 * `seatReplica` is OPTIONAL in the capability map, and absent reads as off,
 * which is exactly right here: a gateway that predates the doors cannot serve
 * this build its file, and the honest answer is the update wall rather than a
 * phone that mounts and then finds no snapshot to fetch.
 */
export function supportsMobileOfflineGateway(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const capabilities = (raw as { capabilities?: unknown }).capabilities;
  return (
    isGatewayCapabilities(capabilities) && capabilities.seatReplica === true
  );
}

/** Experimental features this app gates surfaces on, from the SAME `/info`
 * answer the compatibility wall fetched (C1). */
export interface MobileGatewayFeatures {
  automations: boolean;
  connectors: boolean;
}

/** Copy for a member who reaches a switched-off place. Names the GATEWAY. */
export const MOBILE_FEATURE_OFF_COPY: Record<
  keyof MobileGatewayFeatures,
  { title: string; body: string }
> = {
  automations: {
    title: "Rules are off",
    body: "This gateway has not switched rules on — turn them on from the desktop.",
  },
  connectors: {
    title: "Connectors are off",
    body: "This gateway has not switched connectors on — turn them on from the desktop.",
  },
};

/** Absent flag reads OFF. Never returns `undefined`: "never answered" is the
 * caller's fact (`requireMobileOfflineGateway`), distinct from a verdict. */
export function readMobileGatewayFeatures(raw: unknown): MobileGatewayFeatures {
  const capabilities =
    raw !== null && typeof raw === "object"
      ? (raw as { capabilities?: unknown }).capabilities
      : undefined;
  if (!isGatewayCapabilities(capabilities))
    return { automations: false, connectors: false };
  return {
    automations: capabilities.automations === true,
    connectors: capabilities.connectors === true,
  };
}

/** Chooses which side is older on `protocol_mismatch` (C1(b)). */
export function judgeMobileGatewayCompatibility(
  raw: unknown
): MobileCompatibilityDisposition | "supported" {
  const judged = judgeGatewayInfo(raw);
  if (judged.ok)
    return supportsMobileOfflineGateway(raw) ? "supported" : "update-gateway";
  if (judged.reason !== "protocol_mismatch") return "update-gateway";

  const protocol =
    raw !== null && typeof raw === "object"
      ? readProtocolFromInfo(raw as Record<string, unknown>)
      : { protocolVersion: null, minSupportedProtocol: null };
  if (
    protocol.minSupportedProtocol !== null &&
    GATEWAY_PROTOCOL_VERSION < protocol.minSupportedProtocol
  )
    return "update-app";
  if (
    protocol.protocolVersion !== null &&
    protocol.protocolVersion < GATEWAY_MIN_PROTOCOL_VERSION
  )
    return "update-gateway";
  // Non-overlapping window: safest read is a newer peer — a store update
  // refreshes the app's complete protocol range.
  return "update-app";
}
