import { isGatewayCapabilities } from "@centraid/client/replica/native";
import {
  GATEWAY_MIN_PROTOCOL_VERSION,
  GATEWAY_PROTOCOL_VERSION,
  judgeGatewayInfo,
  readProtocolFromInfo,
} from "@centraid/protocol";

export type MobileCompatibilityDisposition =
  | "update-gateway"
  | "update-app"
  | "reconnect";

export const MOBILE_GATEWAY_UPDATE_MESSAGE =
  "Update the Centraid gateway on your desktop, then reconnect. This mobile version requires the current protocol, multi-vault offline sync, and cross-vault placements.";
export const MOBILE_APP_UPDATE_MESSAGE =
  "Update the Centraid mobile app from the App Store or Google Play. Mobile updates are store-only on this installation.";
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

export function supportsMobileOfflineGateway(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const capabilities = (raw as { capabilities?: unknown }).capabilities;
  return (
    isGatewayCapabilities(capabilities) &&
    capabilities.multiVaultReplica === true &&
    capabilities.crossVaultPlacements === true
  );
}

/**
 * C1(b) judgment shared by foreground and background construction.
 * judgeGatewayInfo owns the mutual protocol window; this adapter only chooses
 * which side is older so the one blocking wall can give a useful instruction.
 */
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
  // A contradictory/non-overlapping window is safest treated as a newer peer:
  // updating the store-distributed app refreshes its complete protocol range.
  return "update-app";
}
