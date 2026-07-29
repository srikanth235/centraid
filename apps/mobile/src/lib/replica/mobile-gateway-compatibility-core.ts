import { isGatewayCapabilities } from "@centraid/client/replica/native";

export const MOBILE_GATEWAY_UPDATE_MESSAGE =
  "Update Centraid on the desktop, then reconnect. This mobile version requires multi-vault offline sync and cross-vault placements.";
export const MOBILE_GATEWAY_RECONNECT_MESSAGE =
  "Reconnect to the desktop once to verify it supports this mobile offline version.";

export function supportsMobileOfflineGateway(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object") return false;
  const capabilities = (raw as { capabilities?: unknown }).capabilities;
  return (
    isGatewayCapabilities(capabilities) &&
    capabilities.multiVaultReplica === true &&
    capabilities.crossVaultPlacements === true
  );
}
