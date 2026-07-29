import {
  listGatewayDevices,
  renameGatewayMember,
} from "../../../gateway-client.js";

/*
 * The signed-in person's own profile.
 *
 * A name belongs to the PERSON, not to the browser that typed it. Onboarding
 * used to write it only into device-local settings, where nothing rendered it
 * and no other household member could ever see it — the roster kept saying
 * "You". These helpers read and write the roster instead, and the local
 * avatar colour rides along through `updateProfileMetadata` as before.
 */

/**
 * The label an auto-founded gateway gives its owner before anyone has said
 * who they are (`build-gateway.ts`). It is a placeholder, not a name, so a
 * member still carrying it counts as "not set yet".
 */
export const PLACEHOLDER_MEMBER_LABEL = "You";

export interface SelfProfile {
  memberId: string;
  /** Empty when the member is still carrying the placeholder label. */
  name: string;
  avatarColor: string;
  /** The gateway profile the avatar colour is written back to. */
  gatewayId: string;
}

export function isNameSet(profile: SelfProfile | undefined): boolean {
  return (profile?.name ?? "").trim().length > 0;
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
    memberId: self.memberId,
    name: self.memberLabel === PLACEHOLDER_MEMBER_LABEL ? "" : self.memberLabel,
    avatarColor: active.avatarColor,
    gatewayId: active.id,
  };
}

/**
 * Write the name to the household roster and the colour to this client's
 * gateway profile. The rename is what makes the name visible to anyone else;
 * the colour stays local because it is chrome, not identity.
 */
export async function saveSelfProfile(input: {
  memberId: string;
  name: string;
  avatarColor: string;
  gatewayId: string;
}): Promise<void> {
  const name = input.name.trim();
  if (name) await renameGatewayMember(input.memberId, name);
  await window.CentraidApi.updateProfileMetadata({
    id: input.gatewayId,
    displayName: name,
    avatarColor: input.avatarColor,
  });
}
