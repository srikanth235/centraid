import type * as DesignTokens from "@centraid/design";

import { Channel, hostCapabilities } from "./ipc-core.js";
import { createDeepLinkBuffer } from "./oauth-deep-link.js";

export type ChannelName = (typeof Channel)[keyof typeof Channel];

export type BridgeListener = (event: unknown, payload: unknown) => void;

export interface PreloadBridge {
  invoke: (channel: ChannelName, ...args: unknown[]) => Promise<unknown>;
  on: (channel: ChannelName, listener: BridgeListener) => void;
  off: (channel: ChannelName, listener: BridgeListener) => void;
}

function subscribe<T>(
  bridge: PreloadBridge,
  channel: ChannelName,
  cb: (msg: T) => void
): () => void {
  const listener: BridgeListener = (_event, payload) => cb(payload as T);
  bridge.on(channel, listener);
  return () => bridge.off(channel, listener);
}

export function createCentraidApi(bridge: PreloadBridge) {
  const deepLinkBuffer = createDeepLinkBuffer();
  bridge.on(Channel.DEEP_LINK, (_event, url) => {
    if (typeof url === "string") deepLinkBuffer.enqueue(url);
  });

  return {
    onDeepLink: (cb: (url: string) => void) => deepLinkBuffer.subscribe(cb),
    getHostCapabilities: async () => hostCapabilities(),

    getSettings: () => bridge.invoke(Channel.SETTINGS_GET),
    saveSettings: (patch: Record<string, unknown>) =>
      bridge.invoke(Channel.SETTINGS_SAVE, patch),

    openAppFolder: (input: { id: string }) =>
      bridge.invoke(Channel.APPS_OPEN, input),

    getPublishStatus: (input: { id: string }) =>
      bridge.invoke(Channel.PUBLISH_STATUS, input),
    onPublishEvent: (
      cb: (msg: {
        id: string;
        ok: boolean;
        error?: string;
        publishedAt?: number;
      }) => void
    ) => subscribe(bridge, Channel.PUBLISH_EVENT, cb),

    listGateways: () => bridge.invoke(Channel.GATEWAYS_LIST),
    removeGateway: (input: { id: string }) =>
      bridge.invoke(Channel.GATEWAYS_REMOVE, input),
    renameGateway: (input: { id: string; label: string }) =>
      bridge.invoke(Channel.GATEWAYS_RENAME, input),
    updateProfileMetadata: (input: {
      id: string;
      displayName?: string;
      avatarColor?: string;
    }) => bridge.invoke(Channel.GATEWAYS_UPDATE_METADATA, input),
    setActiveGateway: (input: { id: string }) =>
      bridge.invoke(Channel.GATEWAYS_SET_ACTIVE, input),
    getGatewayAuth: () => bridge.invoke(Channel.GATEWAY_AUTH_GET),
    setGatewayRememberDevice: (input: { rememberDevice: boolean }) =>
      bridge.invoke(Channel.GATEWAY_REMEMBER_DEVICE_SET, input),
    redeemGatewayPairing: (input: {
      ticket: string;
      label?: string;
      rememberDevice?: boolean;
    }) => bridge.invoke(Channel.GATEWAY_PAIR_REDEEM, input),
    listGatewayVaults: (input: { gatewayId: string }) =>
      bridge.invoke(Channel.GATEWAYS_LIST_VAULTS, input),
    testGatewayConnection: (
      input:
        | { kind: "ticket"; ticket: string }
        | { kind: "gateway"; gatewayId: string }
    ) => bridge.invoke(Channel.GATEWAY_TEST_CONNECTION, input),
    getGatewayRuntime: () => bridge.invoke(Channel.GATEWAY_RUNTIME_GET),
    onGatewayRuntime: (cb: (snapshot: unknown) => void) =>
      subscribe(bridge, Channel.GATEWAY_RUNTIME_EVENT, cb),
    restartGateway: () => bridge.invoke(Channel.GATEWAY_RESTART),
    retryGatewayStart: () => bridge.invoke(Channel.GATEWAY_START_RETRY),
    exportGatewayDiagnostics: () =>
      bridge.invoke(Channel.GATEWAY_DIAGNOSTICS_EXPORT),
    exportGatewayRecoveryKit: (input: { password: string }) =>
      bridge.invoke(Channel.GATEWAY_RECOVERY_KIT_EXPORT, input),
    onGatewayChanged: (
      cb: (msg: {
        activeGatewayId: string;
        activeGatewayKind: "local" | "remote";
        activeGatewayLabel: string;
        activeProfileDisplayName: string;
        activeProfileAvatarColor: string;
        gatewayId?: string;
        removedGatewayId?: string;
        purgeReplicaGatewayId?: string;
      }) => void
    ) => subscribe(bridge, Channel.GATEWAY_CHANGED, cb),

    setActiveVault: (input: { vaultId?: string }) =>
      bridge.invoke(Channel.VAULTS_SET_ACTIVE, input),
    createVault: (input: { name?: string }) =>
      bridge.invoke(Channel.VAULTS_CREATE, input),
    deleteVault: (input: { vaultId: string; name: string }) =>
      bridge.invoke(Channel.VAULTS_DELETE, input),
    notifyVaultMetadataChanged: () =>
      bridge.invoke(Channel.VAULT_METADATA_CHANGED),
    onVaultChanged: (
      cb: (msg: {
        activeGatewayId: string;
        gatewayId?: string;
        activeVaultId?: string;
      }) => void
    ) => subscribe(bridge, Channel.VAULT_CHANGED, cb),
    onVaultMetadataChanged: (cb: () => void) =>
      subscribe(bridge, Channel.VAULT_METADATA_PUSH, () => cb()),

    getPhoneLinkStatus: () => bridge.invoke(Channel.PHONE_STATUS),
    beginPhonePairing: () => bridge.invoke(Channel.PHONE_BEGIN_PAIRING),
    cancelPhonePairing: () => bridge.invoke(Channel.PHONE_CANCEL_PAIRING),
    revokePhoneDevice: (input: { deviceId: string }) =>
      bridge.invoke(Channel.PHONE_REVOKE, input),
    onPhonePaired: (cb: (msg: { device: unknown }) => void) =>
      subscribe(bridge, Channel.PHONE_PAIRED, cb),

    getUpdateStatus: () => bridge.invoke(Channel.UPDATE_STATUS),
    checkForUpdates: () => bridge.invoke(Channel.UPDATE_CHECK),
    relaunchToUpdate: () => bridge.invoke(Channel.UPDATE_RELAUNCH),
    installGatewayService: (): Promise<
      { ok: true } | { ok: false; error: string }
    > =>
      bridge.invoke(Channel.GATEWAY_SERVICE_INSTALL) as Promise<
        { ok: true } | { ok: false; error: string }
      >,

    onUpdateAvailable: (
      cb: (msg: { available: boolean; version: string }) => void
    ) => subscribe(bridge, Channel.UPDATE_AVAILABLE, cb),

    keychainPromptExpected: (): Promise<boolean> =>
      bridge.invoke(Channel.KEYCHAIN_PROMPT_EXPECTED) as Promise<boolean>,

    getChangelog: () => bridge.invoke(Channel.CHANGELOG_GET),
  };
}

export function createCentraidTokens(
  tokens: typeof DesignTokens,
  fontFaceCss: string
) {
  return {
    apps: [...tokens.apps],
    cssText: `${fontFaceCss}\n${tokens.toCss()}`,
    fonts: tokens.fonts,
    icons: tokens.icons,
    palette: tokens.palette,
    radii: tokens.radii,
    spacing: tokens.spacing,
    themes: tokens.themes,
    themePresets: [...tokens.THEME_PRESETS],
    tileFinish: (color: string, variant: DesignTokens.TileVariant) =>
      tokens.tileFinish(color, variant),
    type: tokens.type,
  };
}
