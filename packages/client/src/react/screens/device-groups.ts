/*
 * Devices → people (#726). Every enrollment carries an `ownerId` (schema
 * invariant): grouping is total, no "Unassigned" bucket. A device caller sees
 * only its owner's vaults, so every row is the caller; a device naming a
 * person the roster missed keeps that person (label rides the row).
 */

import { isRevokedDevice } from "../../device-roster.js";
import type {
  CentraidGatewayDevice,
  GatewayDeviceVault,
  GatewayOwner,
  GatewayOwnerVault,
} from "../../gateway-client.js";

/**
 * One physical device with all enrollments folded in: the route returns one
 * row per (device, VAULT), which reads as two devices and revokes one vault.
 */
export interface GroupedDevice extends CentraidGatewayDevice {
  enrollmentIds: string[];
  vaults: GatewayDeviceVault[];
}

export interface OwnerGroup {
  ownerId: string;
  label: string;
  vaults: GatewayOwnerVault[];
  devices: GroupedDevice[];
  /** Tombstoned bindings — past attribution still resolves. */
  revoked: GroupedDevice[];
  /** Holds the device making this request. */
  isSelf: boolean;
}

/** Fold a person's rows into one per `endpointId`. */
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
    // Any row marked current makes the whole device current.
    if (row.current === true) seen.current = true;
  }
  return [...merged.values()];
}

/** Vaults off inherited bindings for an owner the roster didn't list. */
function vaultsFromDevices(
  devices: readonly GroupedDevice[]
): GatewayOwnerVault[] {
  const byVault = new Map<string, GatewayOwnerVault>();
  for (const device of devices) {
    if (isRevokedDevice(device)) continue;
    for (const vault of device.vaults) {
      if (!byVault.has(vault.vaultId)) byVault.set(vault.vaultId, vault);
    }
  }
  return [...byVault.values()];
}

/** One group per person: roster owners plus anyone only devices name. */
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

  // You first, then alphabetical; in practice one group (#726).
  return [...groups.values()].sort((a, b) =>
    a.isSelf === b.isSelf ? a.label.localeCompare(b.label) : a.isSelf ? -1 : 1
  );
}
