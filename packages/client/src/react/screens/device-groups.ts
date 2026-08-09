/*
 * Devices → people (issue #726).
 *
 * Every enrollment carries an `ownerId` — it is a schema invariant, not an
 * optional column — so this grouping is total by construction and there is no
 * "Unassigned" bucket to fall into. A vault has exactly one owner, and a
 * device caller sees only vaults its own owner owns (topology hiding), so
 * every row this grouping ever sees belongs to the SAME person — the caller.
 * When a device names a person the roster call didn't return (a roster
 * surface the gateway doesn't expose, or a refresh race), the group is still
 * that person: the label rides along on the device row, and their vaults are
 * read back off the bindings they inherited.
 */

import { isRevokedDevice } from "../../device-roster.js";
import type {
  CentraidGatewayDevice,
  GatewayDeviceVault,
  GatewayOwner,
  GatewayOwnerVault,
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
  /** The vaults it reaches, in the order the gateway returned them. */
  vaults: GatewayDeviceVault[];
}

export interface OwnerGroup {
  ownerId: string;
  label: string;
  /** The vaults this person owns. */
  vaults: GatewayOwnerVault[];
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
    const vault: GatewayDeviceVault = {
      vaultId: row.vaultId,
      ...(row.vaultName === undefined ? {} : { vaultName: row.vaultName }),
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
    // One enrollment row marked as this device makes the whole device that.
    if (row.current === true) seen.current = true;
  }
  return [...merged.values()];
}

/** Vaults read back off inherited bindings, for an owner the roster didn't list. */
function vaultsFromDevices(
  devices: readonly GroupedDevice[]
): GatewayOwnerVault[] {
  const byVault = new Map<string, GatewayOwnerVault>();
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

/** One group per person: the roster's owner, plus anyone only devices name. */
export function groupDevicesByOwner(
  devices: readonly CentraidGatewayDevice[],
  owners: readonly GatewayOwner[]
): OwnerGroup[] {
  const groups = new Map<string, OwnerGroup>();
  const ensure = (ownerId: string, label: string): OwnerGroup => {
    const existing = groups.get(ownerId);
    if (existing) return existing;
    const created: OwnerGroup = {
      ownerId,
      label,
      vaults: [],
      devices: [],
      revoked: [],
      isSelf: false,
    };
    groups.set(ownerId, created);
    return created;
  };

  for (const owner of owners) {
    ensure(owner.ownerId, owner.label).vaults = owner.vaults;
  }
  const live = new Map<string, CentraidGatewayDevice[]>();
  const dead = new Map<string, CentraidGatewayDevice[]>();
  for (const device of devices) {
    const group = ensure(device.ownerId, device.ownerLabel);
    const bucket = isRevokedDevice(device) ? dead : live;
    const rows = bucket.get(group.ownerId);
    if (rows) rows.push(device);
    else bucket.set(group.ownerId, [device]);
    if (device.current === true) group.isSelf = true;
  }
  for (const group of groups.values()) {
    group.devices = mergeByEndpoint(live.get(group.ownerId) ?? []);
    group.revoked = mergeByEndpoint(dead.get(group.ownerId) ?? []);
    if (group.vaults.length === 0) {
      group.vaults = vaultsFromDevices([...group.devices, ...group.revoked]);
    }
  }

  // You first — it is the group whose devices you must never misidentify —
  // then everyone else alphabetically. In practice there is only ever one
  // group (#726: a device caller sees only its own owner's roster row).
  return [...groups.values()].sort((a, b) =>
    a.isSelf === b.isSelf ? a.label.localeCompare(b.label) : a.isSelf ? -1 : 1
  );
}
