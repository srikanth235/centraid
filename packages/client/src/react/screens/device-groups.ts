/*
 * Devices → people (issue #599 L2).
 *
 * Every enrollment carries a `memberId` — it is a schema invariant, not an
 * optional column — so this grouping is total by construction and there is no
 * "Unassigned" bucket to fall into. When a device names a person the roster
 * call didn't return (a roster surface the gateway doesn't expose, or a
 * refresh race), the group is still that person: the label rides along on the
 * device row, and their access is read back off the bindings they inherited.
 */

import { isRevokedDevice } from "../../device-roster.js";
import type {
  CentraidGatewayDevice,
  GatewayMember,
  GatewayVaultGrant,
} from "../../gateway-client.js";

export interface MemberGroup {
  memberId: string;
  label: string;
  roles: GatewayVaultGrant[];
  devices: CentraidGatewayDevice[];
  /** Tombstoned bindings — kept so past attribution still resolves. */
  revoked: CentraidGatewayDevice[];
  /** Holds the device making this request. */
  isSelf: boolean;
}

/** Roles read back off inherited bindings, for a member the roster didn't list. */
function rolesFromDevices(
  devices: readonly CentraidGatewayDevice[]
): GatewayVaultGrant[] {
  const byVault = new Map<string, GatewayVaultGrant>();
  for (const device of devices) {
    if (isRevokedDevice(device) || byVault.has(device.vaultId)) continue;
    byVault.set(device.vaultId, {
      vaultId: device.vaultId,
      ...(device.vaultName === undefined
        ? {}
        : { vaultName: device.vaultName }),
      role: device.role as GatewayVaultGrant["role"],
    });
  }
  return [...byVault.values()];
}

/** One group per person: the roster's members, plus anyone only devices name. */
export function groupDevicesByMember(
  devices: readonly CentraidGatewayDevice[],
  members: readonly GatewayMember[]
): MemberGroup[] {
  const groups = new Map<string, MemberGroup>();
  const ensure = (memberId: string, label: string): MemberGroup => {
    const existing = groups.get(memberId);
    if (existing) return existing;
    const created: MemberGroup = {
      memberId,
      label,
      roles: [],
      devices: [],
      revoked: [],
      isSelf: false,
    };
    groups.set(memberId, created);
    return created;
  };

  for (const member of members) {
    ensure(member.memberId, member.label).roles = member.roles;
  }
  for (const device of devices) {
    const group = ensure(device.memberId, device.memberLabel);
    if (isRevokedDevice(device)) group.revoked.push(device);
    else group.devices.push(device);
    if (device.current === true) group.isSelf = true;
  }
  for (const group of groups.values()) {
    if (group.roles.length === 0) {
      group.roles = rolesFromDevices([...group.devices, ...group.revoked]);
    }
  }

  // You first — it is the group whose "Remove" button you must never misfire
  // — then everyone else alphabetically.
  return [...groups.values()].sort((a, b) =>
    a.isSelf === b.isSelf ? a.label.localeCompare(b.label) : a.isSelf ? -1 : 1
  );
}

/** Every space the caller can see, for the pairing panel's grant rows. */
export function spacesFromGroups(
  groups: readonly MemberGroup[]
): GatewayVaultGrant[] {
  const byVault = new Map<string, GatewayVaultGrant>();
  for (const group of groups) {
    for (const grant of group.roles) {
      const seen = byVault.get(grant.vaultId);
      if (
        !seen ||
        (seen.vaultName === undefined && grant.vaultName !== undefined)
      ) {
        byVault.set(grant.vaultId, grant);
      }
    }
  }
  return [...byVault.values()];
}
