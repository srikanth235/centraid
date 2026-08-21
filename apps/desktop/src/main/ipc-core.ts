/**
 * IPC channel names + pure broadcast payloads (issue #545 C2).
 *
 * Electron-free: both `ipc.ts` (main) and `preload.ts` import the same
 * `Channel` map so the bridge stays lockstep. Broadcast payload builders
 * capture the exact shape the renderer listeners type against.
 */

/**
 * IPC channel names. Keep in sync with the renderer-side typings in
 * `renderer/centraid-api.d.ts` (and any new surface added there).
 */
export const Channel = {
  SETTINGS_GET: "centraid:settings:get",
  SETTINGS_SAVE: "centraid:settings:save",

  APPS_OPEN: "centraid:apps:open",

  PUBLISH_STATUS: "centraid:publish:status",
  PUBLISH_EVENT: "centraid:publish:event",

  GATEWAYS_LIST: "centraid:gateways:list",
  GATEWAYS_REMOVE: "centraid:gateways:remove",
  GATEWAYS_RENAME: "centraid:gateways:rename",
  GATEWAYS_UPDATE_METADATA: "centraid:gateways:update-metadata",
  GATEWAYS_SET_ACTIVE: "centraid:gateways:set-active",
  GATEWAY_CHANGED: "centraid:gateways:changed",
  GATEWAY_PAIR_REDEEM: "centraid:gateways:pair-redeem",
  GATEWAYS_LIST_VAULTS: "centraid:gateways:list-vaults",
  GATEWAY_TEST_CONNECTION: "centraid:gateways:test-connection",
  VAULTS_SET_ACTIVE: "centraid:vaults:set-active",
  VAULT_CHANGED: "centraid:vaults:changed",
  VAULTS_CREATE: "centraid:vaults:create",
  VAULTS_DELETE: "centraid:vaults:delete",
  VAULT_METADATA_CHANGED: "centraid:vaults:metadata-changed",
  VAULT_METADATA_PUSH: "centraid:vaults:metadata-push",
  GATEWAY_AUTH_GET: "centraid:gateways:auth",
  GATEWAY_REMEMBER_DEVICE_SET: "centraid:gateways:set-remember-device",
  GATEWAY_RUNTIME_GET: "centraid:gateway-runtime:get",
  GATEWAY_RUNTIME_EVENT: "centraid:gateway-runtime:event",
  GATEWAY_RESTART: "centraid:gateway-runtime:restart",
  GATEWAY_START_RETRY: "centraid:gateway-runtime:retry-start",
  GATEWAY_DIAGNOSTICS_EXPORT: "centraid:gateway-runtime:export-diagnostics",
  GATEWAY_RECOVERY_KIT_EXPORT: "centraid:gateway-runtime:export-recovery-kit",

  PHONE_STATUS: "centraid:phone:status",
  PHONE_BEGIN_PAIRING: "centraid:phone:begin-pairing",
  PHONE_CANCEL_PAIRING: "centraid:phone:cancel-pairing",
  PHONE_REVOKE: "centraid:phone:revoke",
  PHONE_PAIRED: "centraid:phone:paired",

  UPDATE_STATUS: "centraid:update:status",
  UPDATE_CHECK: "centraid:update:check",
  UPDATE_RELAUNCH: "centraid:update:relaunch",
  GATEWAY_SERVICE_INSTALL: "centraid:gateway:service-install",
  UPDATE_AVAILABLE: "centraid:update:available",

  KEYCHAIN_PROMPT_EXPECTED: "centraid:keychain:prompt-expected",

  CHANGELOG_GET: "centraid:changelog:get",
  DEEP_LINK: "centraid:deep-link",
} as const;

/** Settings slice used to build gateway-changed broadcasts. */
export interface GatewayChangedSettings {
  activeGatewayId: string;
  activeGatewayKind: "local" | "remote";
  activeGatewayLabel: string;
  activeProfileDisplayName: string;
  activeProfileAvatarColor: string;
}

export interface GatewayChangedDetail {
  removedGatewayId?: string;
  purgeReplicaGatewayId?: string;
}

export function gatewayChangedPayload(
  next: GatewayChangedSettings,
  detail: GatewayChangedDetail = {}
): {
  activeGatewayId: string;
  activeGatewayKind: "local" | "remote";
  activeGatewayLabel: string;
  activeProfileDisplayName: string;
  activeProfileAvatarColor: string;
  gatewayId: string;
  removedGatewayId?: string;
  purgeReplicaGatewayId?: string;
} {
  return {
    activeGatewayId: next.activeGatewayId,
    activeGatewayKind: next.activeGatewayKind,
    activeGatewayLabel: next.activeGatewayLabel,
    activeProfileDisplayName: next.activeProfileDisplayName,
    activeProfileAvatarColor: next.activeProfileAvatarColor,
    gatewayId: next.activeGatewayId,
    ...detail,
  };
}

export function vaultChangedPayload(next: {
  activeGatewayId: string;
  activeVaultId?: string;
}): {
  activeGatewayId: string;
  gatewayId: string;
  activeVaultId?: string;
} {
  return {
    activeGatewayId: next.activeGatewayId,
    gatewayId: next.activeGatewayId,
    ...(next.activeVaultId === undefined
      ? {}
      : { activeVaultId: next.activeVaultId }),
  };
}

/**
 * Will starting the local gateway pop an OS credential prompt? (issue #603)
 *
 * The gateway's first start writes this device's wrapping key + loopback
 * token through `safeStorage` (`gateway-secrets.ts` `writeSecrets` is the
 * single choke point). Whether that is silent or throws up a system dialog is
 * purely a property of the host, so the renderer can pre-warn honestly:
 *
 *  - **no safeStorage encryption** → nothing to prompt for. macOS/Windows
 *    would have thrown before reaching a prompt; Linux falls back to the 0600
 *    device-local secrets file. Either way: no dialog.
 *  - **macOS, unpackaged** (dev / unsigned builds) → the keychain item is not
 *    owned by a stable signed identity, so the login keychain asks for
 *    permission. Packaged + signed builds own their item and stay silent.
 *  - **Linux with a working libsecret/kwallet** → the keyring may need to be
 *    unlocked, which is a prompt.
 *  - **Windows** → DPAPI, always silent.
 *
 * Pure so the policy is unit-testable; `ipc.ts` supplies the live
 * `safeStorage.isEncryptionAvailable()` / `app.isPackaged` / `process.platform`.
 */
export function keychainPromptExpected(host: {
  platform: NodeJS.Platform;
  encryptionAvailable: boolean;
  packaged: boolean;
}): boolean {
  if (!host.encryptionAvailable) return false;
  if (host.platform === "darwin") return !host.packaged;
  if (host.platform === "linux") return true;
  return false;
}

/**
 * Host-capability snapshot the preload exposes. Pure so the capability
 * flags stay unit-testable.
 *
 * `compute.transcript` is a permanent `false` (issue #724 W6): desktop's
 * on-device file-ASR adapter (`device-transcription.ts`, the
 * `CENTRAID_DEVICE_ASR_*` env trio, and the `DEVICE_TRANSCRIPT_AVAILABLE` /
 * `DEVICE_TRANSCRIBE` IPC channels) is deleted — transcription now runs on
 * the gateway's deterministic `transcript` automation, never on a
 * member's desktop. The key ITSELF stays in the return shape rather than
 * being dropped: `compute` is the fixed wire shape a device PUTs to the
 * gateway's compute-advertisement endpoint
 * (`packages/client/src/gateway-client-devices.ts`'s
 * `DeviceComputeCapabilities`), and narrowing that shape here would leave
 * this one host type diverging from the wire contract every other caller
 * still serializes against.
 */
export function hostCapabilities(): {
  platform: "desktop";
  compute: {
    previews: true;
    poster: true;
    pdfText: true;
    ocr: false;
    embedding: false;
    transcript: false;
    edgeSeal: true;
    backgroundTransfer: false;
  };
} {
  return {
    platform: "desktop",
    compute: {
      previews: true,
      poster: true,
      pdfText: true,
      ocr: false,
      embedding: false,
      transcript: false,
      edgeSeal: true,
      backgroundTransfer: false,
    },
  };
}
