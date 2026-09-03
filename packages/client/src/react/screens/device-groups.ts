import { isRevokedDevice } from "../../device-roster.js";
import type {
  CentraidGatewayDevice,
  GatewayDeviceVault,
  GatewayOwner,
  GatewayOwnerVault,
} from "../../gateway-client.js";

export interface GroupedDevice extends CentraidGatewayDevice {
  enrollmentIds: string[];
  vaults: GatewayDeviceVault[];
}

export interface OwnerGroup {
  ownerId: string;
  label: string;
  vaults: GatewayOwnerVault[];
  devices: GroupedDevice[];
  revoked: GroupedDevice[];
  isSelf: boolean;
}

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
    if (row.current === true) seen.current = true;
  }
  return [...merged.values()];
}

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

  return [...groups.values()].sort((a, b) =>
    a.isSelf === b.isSelf ? a.label.localeCompare(b.label) : a.isSelf ? -1 : 1
  );
}
