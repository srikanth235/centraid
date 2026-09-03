import type { IconName } from "@centraid/design";

import { listVaults } from "../../../gateway-client.js";
import type { PhoneBridgeProps } from "../../screen-contracts.js";

export interface ActiveVaultData {
  vaultId: string;
  name: string;
  icon: IconName;
  color: string;
  blurb: string;
  deletable: boolean;
  connection?: RemoteConnectionData;
}

export interface RemoteConnectionData {
  gatewayId: string;
  siblingNames: string[];
}

export interface ThisDeviceData {
  gatewayId?: string;
  gatewayLabel?: string;
  offlineCopy: boolean;
}

export async function loadThisDeviceData(): Promise<ThisDeviceData> {
  const auth = await window.CentraidApi.getGatewayAuth().catch(() => undefined);
  if (!auth?.gatewayId) return { offlineCopy: false };
  const label = await window.CentraidApi.listGateways()
    .then((rows) => rows.find((row) => row.id === auth.gatewayId)?.label)
    .catch(() => undefined);
  return {
    gatewayId: auth.gatewayId,
    gatewayLabel: label ?? "this gateway",
    offlineCopy: auth.rememberDevice === true,
  };
}

export async function loadSettingsStamp(): Promise<string> {
  const version = await window.CentraidApi.getChangelog?.()
    .then((changelog) => changelog.currentVersion.replace(/^v/iu, ""))
    .catch(() => undefined);
  const host = await window.CentraidApi.getGatewayAuth()
    .then((auth) => gatewayHost(auth.baseUrl))
    .catch(() => undefined);
  return [version ? `Centraid ${version}` : "Centraid", host]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
}

function gatewayHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "";
  }
}

export async function setOfflineCopy(enabled: boolean): Promise<boolean> {
  const result = await window.CentraidApi.setGatewayRememberDevice({
    rememberDevice: enabled,
  });
  return result.rememberDevice;
}

export async function forgetThisDeviceLocally(
  gatewayId: string | undefined
): Promise<void> {
  if (gatewayId) await window.CentraidApi.removeGateway({ id: gatewayId });
  await window.CentraidApi.saveSettings({ onboardingCompletedAt: undefined });
}

export async function loadActiveVaultData(): Promise<ActiveVaultData | null> {
  const vaultList = await listVaults()
    .then((v) => v ?? [])
    .catch(() => []);
  const activeVaultId = await window.CentraidApi.getGatewayAuth()
    .then((a) => a.vaultId ?? vaultList[0]?.vaultId ?? "")
    .catch(() => vaultList[0]?.vaultId ?? "");
  const active = vaultList.find((v) => v.vaultId === activeVaultId);
  if (!active) return null;
  return {
    blurb: active.blurb ?? "",
    color: active.color ?? "#4E68DD",
    deletable: vaultList.length > 1,
    icon: (active.icon as IconName) ?? "Folder",
    name: active.name,
    vaultId: active.vaultId,
    ...(await loadRemoteConnection(active.vaultId, vaultList)),
  };
}

async function loadRemoteConnection(
  activeVaultId: string,
  vaultList: readonly { vaultId: string; name: string }[]
): Promise<{ connection?: RemoteConnectionData }> {
  const gatewayId = await window.CentraidApi.getGatewayAuth()
    .then((a) => a.gatewayId)
    .catch(() => undefined);
  if (!gatewayId) return {};
  const kind = await window.CentraidApi.listGateways?.()
    .then((rows) => rows.find((row) => row.id === gatewayId)?.kind)
    .catch(() => undefined);
  if (kind !== "remote") return {};
  return {
    connection: {
      gatewayId,
      siblingNames: vaultList
        .filter((v) => v.vaultId !== activeVaultId)
        .map((v) => v.name),
    },
  };
}

export function phoneCallbacks(
  showToast: (m: string) => void
): PhoneBridgeProps {
  return {
    showToast,
    beginPairing: async (onPaired) => {
      const pairing = await window.CentraidApi.beginPhonePairing().catch(
        () => undefined
      );
      if (!pairing) return null;
      const stop = window.CentraidApi.onPhonePaired(({ device }) => {
        stop();
        onPaired(device.name);
      });
      return {
        cancel: () => {
          stop();
          void window.CentraidApi.cancelPhonePairing();
        },
        info: { expiresAt: pairing.expiresAt, qrDataUrl: pairing.qrDataUrl },
      };
    },
    loadStatus: async () => {
      const s = await window.CentraidApi.getPhoneLinkStatus().catch(
        () => undefined
      );
      if (!s) return null;
      return {
        devices: s.devices.map((d) => ({
          addedAt: d.addedAt,
          deviceId: d.deviceId,
          endpointId: d.endpointId,
          name: d.name,
          platform: d.platform,
        })),
        error: s.error,
        running: s.running,
      };
    },
    revoke: async (deviceId) => {
      const result = await window.CentraidApi.revokePhoneDevice({
        deviceId,
      }).catch(() => undefined);
      return !!result?.removed;
    },
  };
}
