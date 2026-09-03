import type { CentraidGatewayDevice } from "./gateway-client-devices.js";

export function isRevokedDevice(device: CentraidGatewayDevice): boolean {
  return device.revoked;
}
