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
  "This mobile version needs the current protocol, multi-vault offline sync, and cross-vault placements.";
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
 * The experimental gateway features (v0 early feedback) this app gates a
 * surface on. Read off the SAME `/centraid/_gateway/info` answer the
 * compatibility wall already fetched — C1 says capabilities are detected in
 * one place and never re-derived per screen.
 */
export interface MobileGatewayFeatures {
  /** The Automations place — lifecycle, runs feed, webhook ingress. */
  automations: boolean;
  /** The Connectors place — connection health/configure, consent ceremony. */
  connectors: boolean;
}

/**
 * What a member sees if they reach a switched-off place anyway — a deep link,
 * a saved shortcut, a row on another screen. Beside the compatibility wall
 * copy above for the same reason: the words a wall says are part of the
 * judgment, not of the screen that happens to draw them.
 *
 * It names the GATEWAY, not the app: nothing is missing from this phone, and
 * the switch is not on it either.
 */
export const MOBILE_FEATURE_OFF_COPY: Record<
  keyof MobileGatewayFeatures,
  { title: string; body: string }
> = {
  automations: {
    title: "Automations are off",
    body: "This gateway has not switched automations on — turn them on from the desktop.",
  },
  connectors: {
    title: "Connectors are off",
    body: "This gateway has not switched connectors on — turn them on from the desktop.",
  },
};

/**
 * What this gateway says it has switched on. Absent flag reads as OFF (the
 * protocol keys are optional, so a gateway that predates them handshakes
 * clean); a body that is not a capability map at all reads as off too, since
 * this is only ever called on an answer that already passed the wall.
 *
 * `undefined` is NOT produced here — "the gateway never answered" is the
 * caller's fact (see `requireMobileOfflineGateway`), and consumers must keep
 * the two apart: an unanswered question is not a verdict, so it may not hide
 * a surface.
 */
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
