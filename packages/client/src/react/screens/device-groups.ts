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

/**
 * One physical device, with every enrollment it holds folded in.
 *
 * The devices route returns a row per (device, VAULT) enrollment, so a browser
 * paired into Shared + Personal came back twice. Rendered raw that reads as
 * two devices — the card counted "4 devices" for two — and each copy carried a
 * button labelled "Revoke device" that only dropped one vault. The user thinks
 * in hardware, so the row is hardware and `enrollmentIds` carries what revoking
 * it has to remove.
 */
export interface GroupedDevice extends CentraidGatewayDevice {
  /** Every enrollment row this device holds; revoking the device drops all. */
  enrollmentIds: string[];
  /**
   * The vaults it reaches, in the order the gateway returned them. The role
   * rides on the VAULT, not the device: it is authored per (person, vault),
   * so a device can be admin in Personal and read-only in Shared.
   */
  vaults: GatewayVaultGrant[];
}

export interface MemberGroup {
  memberId: string;
  label: string;
  roles: GatewayVaultGrant[];
  devices: GroupedDevice[];
  /** Tombstoned bindings — kept so past attribution still resolves. */
  revoked: GroupedDevice[];
  /** Holds the device making this request. */
  isSelf: boolean;
}

/** Fold a person's enrollment rows into one row per `endpointId`. */
function mergeByEndpoint(
  rows: readonly CentraidGatewayDevice[]
): GroupedDevice[] {
  const merged = new Map<string, GroupedDevice>();
  for (const row of rows) {
    const seen = merged.get(row.endpointId);
    const vault: GatewayVaultGrant = {
      vaultId: row.vaultId,
      ...(row.vaultName === undefined ? {} : { vaultName: row.vaultName }),
      role: row.role as GatewayVaultGrant["role"],
    };
    if (!seen) {
      merged.set(row.endpointId, {
        ...row,
        enrollmentIds: [row.deviceId],
        vaults: [vault],
      });
      continue;
    }
    seen.enrollmentIds.push(row.deviceId);
    if (!seen.vaults.some((held) => held.vaultId === vault.vaultId)) {
      seen.vaults.push(vault);
    }
    // `current` and the richer role win across rows: one enrollment marked as
    // this device, or as admin, makes the whole device that.
    if (row.current === true) seen.current = true;
    if (row.role === "admin") seen.role = "admin";
  }
  return [...merged.values()];
}

/** Roles read back off inherited bindings, for a member the roster didn't list. */
function rolesFromDevices(
  devices: readonly GroupedDevice[]
): GatewayVaultGrant[] {
  const byVault = new Map<string, GatewayVaultGrant>();
  for (const device of devices) {
    if (isRevokedDevice(device)) continue;
    // Read every vault the merged device reaches, not just the one its first
    // enrollment row happened to name.
    for (const vault of device.vaults) {
      if (!byVault.has(vault.vaultId)) byVault.set(vault.vaultId, vault);
    }
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
  const live = new Map<string, CentraidGatewayDevice[]>();
  const dead = new Map<string, CentraidGatewayDevice[]>();
  for (const device of devices) {
    const group = ensure(device.memberId, device.memberLabel);
    const bucket = isRevokedDevice(device) ? dead : live;
    const rows = bucket.get(group.memberId);
    if (rows) rows.push(device);
    else bucket.set(group.memberId, [device]);
    if (device.current === true) group.isSelf = true;
  }
  for (const group of groups.values()) {
    group.devices = mergeByEndpoint(live.get(group.memberId) ?? []);
    group.revoked = mergeByEndpoint(dead.get(group.memberId) ?? []);
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

/** Every vault the caller can see, for the pairing panel's grant rows. */
export function vaultsFromGroups(
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
