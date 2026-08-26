import {
  listGatewayDevices,
  renameGatewayOwner,
} from "../../../gateway-client.js";

/*
 * The signed-in person's own profile.
 *
 * A name belongs to the PERSON, not to the browser that typed it. Writing it
 * only into device-local settings leaves nothing rendering it and no other
 * surface able to see it — the roster keeps saying "You". These helpers read
 * and write the owner roster instead, and the local avatar colour rides along
 * through `updateProfileMetadata`.
 */

/**
 * The label an auto-founded gateway gives its owner before anyone has said
 * who they are (`build-gateway.ts`). It is a placeholder, not a name, so an
 * owner still carrying it counts as "not set yet".
 */
export const PLACEHOLDER_OWNER_LABEL = "You";

export interface SelfProfile {
  ownerId: string;
  /** Empty when the owner is still carrying the placeholder label. */
  name: string;
  avatarColor: string;
  /** The gateway profile the avatar colour is written back to. */
  gatewayId: string;
}

/** Resolve the person this client acts as, via the device marked `current`. */
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

/**
 * Write the name to the owner roster and the colour to this client's gateway
 * profile. The rename is what makes the name visible to anyone else; the
 * colour stays local because it is chrome, not identity.
 */
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
