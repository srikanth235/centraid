/**
 * The renderer/main privilege boundary in testable form (#656): every channel
 * comes from the shared `Channel` map and the only capability handed in is the
 * narrow `PreloadBridge` seam. Keep it Electron-free — an `electron` import
 * here defeats the split. `preload.ts` stays a trivially-correct shell.
 */

import type * as DesignTokens from "@centraid/design";

import { Channel, hostCapabilities } from "./ipc-core.js";
import { createDeepLinkBuffer } from "./oauth-deep-link.js";

export type ChannelName = (typeof Channel)[keyof typeof Channel];

/** `event` is never read or forwarded: it carries `sender`, which must never
 *  cross the contextBridge. */
export type BridgeListener = (event: unknown, payload: unknown) => void;

/**
 * Deliberately not a re-export of `ipcRenderer`: the factories receive only
 * these three functions, so nothing they build can leak it. `off` must detach
 * by listener identity.
 */
export interface PreloadBridge {
  invoke: (channel: ChannelName, ...args: unknown[]) => Promise<unknown>;
  on: (channel: ChannelName, listener: BridgeListener) => void;
  off: (channel: ChannelName, listener: BridgeListener) => void;
}

/** The one place the sender event is dropped, so subscribe/unsubscribe on the
 *  `on*` members cannot drift. */
function subscribe<T>(
  bridge: PreloadBridge,
  channel: ChannelName,
  cb: (msg: T) => void
): () => void {
  const listener: BridgeListener = (_event, payload) => cb(payload as T);
  bridge.on(channel, listener);
  return () => bridge.off(channel, listener);
}

/**
 * Also owns the deep-link handoff queue: a warm `centraid://oauth/finish` can
 * land after document load but before the renderer subscribes, so the listener
 * registers at preload time and buffers until `onDeepLink` runs.
 */
export function createCentraidApi(bridge: PreloadBridge) {
  const deepLinkBuffer = createDeepLinkBuffer();
  bridge.on(Channel.DEEP_LINK, (_event, url) => {
    if (typeof url === "string") deepLinkBuffer.enqueue(url);
  });

  return {
    onDeepLink: (cb: (url: string) => void) => deepLinkBuffer.subscribe(cb),
    // No desktop file-ASR probe (#724): transcription runs on the recognition
    // automation, never a device compute lease.
    getHostCapabilities: async () => hostCapabilities(),

    getSettings: () => bridge.invoke(Channel.SETTINGS_GET),
    saveSettings: (patch: Record<string, unknown>) =>
      bridge.invoke(Channel.SETTINGS_SAVE, patch),

    // App lifecycle is renderer-side HTTP; no preview iframe, no served plane
    // (#799).
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

    // No manual "add by URL + token" bridge (#505): gateways arrive through
    // the pairing ceremony, which adds the profile itself.
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
    // The token's single bridge crossing.
    getGatewayAuth: () => bridge.invoke(Channel.GATEWAY_AUTH_GET),
    // Pairing never asks about the offline copy; this is the only answer path.
    setGatewayRememberDevice: (input: { rememberDevice: boolean }) =>
      bridge.invoke(Channel.GATEWAY_REMEMBER_DEVICE_SET, input),
    redeemGatewayPairing: (input: {
      ticket: string;
      label?: string;
      rememberDevice?: boolean;
    }) => bridge.invoke(Channel.GATEWAY_PAIR_REDEEM, input),
    // Without switching to it (#376).
    listGatewayVaults: (input: { gatewayId: string }) =>
      bridge.invoke(Channel.GATEWAYS_LIST_VAULTS, input),
    // Never rejects (#382): failures come back as stages.
    testGatewayConnection: (
      input:
        | { kind: "ticket"; ticket: string }
        | { kind: "gateway"; gatewayId: string }
    ) => bridge.invoke(Channel.GATEWAY_TEST_CONNECTION, input),
    getGatewayRuntime: () => bridge.invoke(Channel.GATEWAY_RUNTIME_GET),
    onGatewayRuntime: (cb: (snapshot: unknown) => void) =>
      subscribe(bridge, Channel.GATEWAY_RUNTIME_EVENT, cb),
    restartGateway: () => bridge.invoke(Channel.GATEWAY_RESTART),
    // Separate from `restartGateway`, which resolves the active gateway first
    // — the very call that fails when there is nothing to restart yet.
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

    // A pointer flip — no server call (#289).
    setActiveVault: (input: { vaultId?: string }) =>
      bridge.invoke(Channel.VAULTS_SET_ACTIVE, input),
    createVault: (input: { name?: string }) =>
      bridge.invoke(Channel.VAULTS_CREATE, input),
    deleteVault: (input: { vaultId: string; name: string }) =>
      bridge.invoke(Channel.VAULTS_DELETE, input),
    // Must stay separate from VAULT_CHANGED: no addressing changed, so this
    // must not trigger `reScope`'s navigate-Home in App.tsx.
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

    // Templates, conversation, user prefs, harness detection, and automations
    // are renderer-side HTTP — never add IPC bridges for them.

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

    // True when starting the local gateway here will pop a credential prompt.
    keychainPromptExpected: (): Promise<boolean> =>
      bridge.invoke(Channel.KEYCHAIN_PROMPT_EXPECTED) as Promise<boolean>,

    getChangelog: () => bridge.invoke(Channel.CHANGELOG_GET),
  };
}

/**
 * A pure projection of the design-token package. Arrays are copied so the
 * renderer cannot mutate the package's exports through the bridge.
 * `fontFaceCss` must stay concatenated AHEAD of the token CSS in one string: a
 * face declared after the first `var()` lookup paints one frame in the UA
 * default font.
 */
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
