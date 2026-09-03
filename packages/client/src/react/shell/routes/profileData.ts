import {
  listGatewayDevices,
  renameGatewayOwner,
} from "../../../gateway-client.js";

export const PLACEHOLDER_OWNER_LABEL = "You";

export interface SelfProfile {
  ownerId: string;
  name: string;
  avatarColor: string;
  gatewayId: string;
}

export async function loadSelfProfile(): Promise<SelfProfile | undefined> {
  const [devices, auth] = await Promise.all([
    listGatewayDevices().catch(() => []),
    window.CentraidApi.getGatewayAuth().catch(() => undefined),
  ]);
  const self = devices.find((device) => device.current === true);
  if (!self) return undefined;
  const gateways = await window.CentraidApi.listGateways().catch(() => []);
  const active =
    gateways.find((row) => row.id === auth?.gatewayId) ?? gateways[0];
  if (!active) return undefined;
  return {
    ownerId: self.ownerId,
    name: self.ownerLabel === PLACEHOLDER_OWNER_LABEL ? "" : self.ownerLabel,
    avatarColor: active.avatarColor,
    gatewayId: active.id,
  };
}

export async function saveSelfProfile(input: {
  ownerId: string;
  name: string;
  avatarColor: string;
  gatewayId: string;
}): Promise<void> {
  const name = input.name.trim();
  if (name) await renameGatewayOwner(input.ownerId, name);
  await window.CentraidApi.updateProfileMetadata({
    id: input.gatewayId,
    displayName: name,
    avatarColor: input.avatarColor,
  });
}
