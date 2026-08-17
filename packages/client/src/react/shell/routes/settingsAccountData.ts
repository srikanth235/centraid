import type { IconName } from "@centraid/design";

import { listVaults } from "../../../gateway-client.js";
import type { PhoneBridgeProps } from "../../screen-contracts.js";

/** Settings → Vault page data (issue #382) — scoped to the ACTIVE vault
 *  only; the cross-vault list + gateway "Connections" group both moved to
 *  the switcher, which is the pair manager now. */
export interface ActiveVaultData {
  vaultId: string;
  name: string;
  icon: IconName;
  color: string;
  blurb: string;
  /** False when this is the last vault on its gateway — mirrors the retired
   *  Vaults list's `primordial` guard (never let the user delete their only
   *  vault from here). */
  deletable: boolean;
  /** Present only when this vault is reached over a REMOTE connection — the
   *  primordial local gateway is this machine, so there is nothing to
   *  disconnect from and the danger-zone action is simply absent (issue #665). */
  connection?: RemoteConnectionData;
}

/** The connection the active vault arrives over, and everything else that
 *  arrives with it — dropping it is connection-wide, never per-vault, so the
 *  confirm has to be able to name the siblings. */
export interface RemoteConnectionData {
  gatewayId: string;
  /** Every OTHER vault this connection serves, by name. */
  siblingNames: string[];
}

/** Settings → This device — the browser's own half of the pairing. */
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

/**
 * Turn this device's offline copy on or off.
 *
 * The pairing/onboarding flow stopped asking (it is ON by default), so this is
 * the whole of the user's control over it. The host owns the consequences —
 * cache purge, replica drop, durable-storage request — because they differ per
 * host; this is only the call.
 */
export async function setOfflineCopy(enabled: boolean): Promise<boolean> {
  const result = await window.CentraidApi.setGatewayRememberDevice({
    rememberDevice: enabled,
  });
  return result.rememberDevice;
}

/**
 * Drop this browser's pairing. `removeGateway` already owns the full local
 * purge (connection, device key, tunnel caches, replica); clearing
 * `onboardingCompletedAt` is what actually returns the shell to onboarding
 * rather than leaving it on a signed-out screen with no way forward.
 */
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

/**
 * Resolve the active vault's connection, when it is a remote one.
 *
 * `listVaults()` already answers for the gateway this client addresses, so its
 * entries ARE the sibling set — no second probe. A local connection resolves to
 * `{}`: this machine is not something the owner disconnects from.
 */
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

// Account-page data — the Phone (app-phone.ts) bridge callback wiring for the
// Settings Account pages. Phone talks to the main process, because the tunnel
// endpoint outlives renderer reloads. The Import pane's callbacks lived here
// too until issue #807 removed the hidden Import page.

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
