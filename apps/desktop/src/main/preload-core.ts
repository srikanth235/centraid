/**
 * Pure construction of the two objects `preload.ts` hands to
 * `contextBridge.exposeInMainWorld` (issue #656, Layer 1F).
 *
 * This module is the renderer/main privilege boundary in testable form:
 * every channel it reaches for comes from the shared `Channel` map, and the
 * only capability it is handed is the narrow `PreloadBridge` seam. Keep it
 * **Electron-free** — importing `electron` here would make the boundary
 * untestable again and defeat the split.
 *
 * `preload.ts` stays a trivially-correct shell: build the bridge from
 * `ipcRenderer`, call these factories, expose the results.
 */

import type * as DesignTokens from "@centraid/design";

import { Channel, hostCapabilities } from "./ipc-core.js";
import { createDeepLinkBuffer } from "./oauth-deep-link.js";

/** Channel name — every bridge call is constrained to the shared map. */
export type ChannelName = (typeof Channel)[keyof typeof Channel];

/**
 * A push listener, shaped exactly like Electron's: the sender event first,
 * then the broadcast payload. The core never reads (or forwards) `event` —
 * it carries `sender`, which must never cross the contextBridge.
 */
export type BridgeListener = (event: unknown, payload: unknown) => void;

/**
 * Minimal seam over `ipcRenderer`. Deliberately does NOT re-export the
 * Electron object: the factories below only ever receive these three
 * functions, so nothing they build can leak `ipcRenderer` to the renderer.
 * `off` must detach by listener identity, same contract as `ipcRenderer.off`.
 */
export interface PreloadBridge {
  invoke: (channel: ChannelName, ...args: unknown[]) => Promise<unknown>;
  on: (channel: ChannelName, listener: BridgeListener) => void;
  off: (channel: ChannelName, listener: BridgeListener) => void;
}

/**
 * Subscribe helper: registers `cb` on `channel` and returns the detach.
 * Every `on*` member of the API is built from this, so subscription and
 * unsubscription can never drift apart, and the sender event is dropped in
 * exactly one place.
 */
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
 * Build the `window.CentraidApi` object. Also owns the deep-link handoff
 * queue: Electron may deliver a warm `centraid://oauth/finish` link after the
 * document loads but before the renderer subscribes, so the listener is
 * registered here (at preload time) and buffered until `onDeepLink` runs.
 */
export function createCentraidApi(bridge: PreloadBridge) {
  const deepLinkBuffer = createDeepLinkBuffer();
  bridge.on(Channel.DEEP_LINK, (_event, url) => {
    if (typeof url === "string") deepLinkBuffer.enqueue(url);
  });

  return {
    onDeepLink: (cb: (url: string) => void) => deepLinkBuffer.subscribe(cb),
    // Desktop file-ASR (device-transcription.ts, the on-device probe this
    // used to make) is gone (issue #724 W6) — transcription now runs on the
    // self-contained recognition automation, never a device compute lease, so
    // this is a pure synchronous snapshot again.
    getHostCapabilities: async () => hostCapabilities(),

    // Settings
    getSettings: () => bridge.invoke(Channel.SETTINGS_GET),
    saveSettings: (patch: Record<string, unknown>) =>
      bridge.invoke(Channel.SETTINGS_SAVE, patch),

    // Apps: list/create/files/write/delete/update-meta moved to the
    // renderer's direct HTTP client (renderer/gateway-client.ts) under the
    // thin-client pivot. The preview iframe points at the gateway draft URL
    // (Phase 4), so only the local-only reveal-in-Finder stays on IPC.
    openAppFolder: (input: { id: string }) =>
      bridge.invoke(Channel.APPS_OPEN, input),

    // Publish moved to the renderer's direct HTTP client (it holds the
    // editing session and POSTs `…/publish`). Auto-publish queue (issue
    // #108) — workspaces upload to the gateway on every save. Renderer can
    // poll a snapshot of the status, or subscribe to per-event broadcasts to
    // toast failures inline.
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

    // Gateways (issue #109) — multi-gateway lifecycle. Local gateway is
    // always present; remote gateways use their iroh EndpointId. Issue #505
    // phase 7 removed the manual "add by URL + token" bridge — gateways are
    // added through the pairing ceremony (`redeemGatewayPairing`), which adds
    // the profile itself.
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
    // Active gateway's HTTP base URL + bearer token for the renderer's
    // direct data-plane client. Token originates in keychain-backed
    // settings (main); this is the single bridge crossing for it.
    getGatewayAuth: () => bridge.invoke(Channel.GATEWAY_AUTH_GET),
    // Settings → This device: flip the active gateway's offline copy. The
    // pairing flow stopped asking, so this is the only way to answer it.
    setGatewayRememberDevice: (input: { rememberDevice: boolean }) =>
      bridge.invoke(Channel.GATEWAY_REMEMBER_DEVICE_SET, input),
    // Pairing-ticket redemption (issue #376): decode + dial/POST, add-or-reuse
    // the gateway profile, flip active gateway + active vault together.
    redeemGatewayPairing: (input: {
      ticket: string;
      label?: string;
      rememberDevice?: boolean;
    }) => bridge.invoke(Channel.GATEWAY_PAIR_REDEEM, input),
    // Preview a gateway's vault list WITHOUT switching to it (issue #376) —
    // the flat (gateway, vault) switcher.
    listGatewayVaults: (input: { gatewayId: string }) =>
      bridge.invoke(Channel.GATEWAYS_LIST_VAULTS, input),
    // ConnectFlow "handshake ladder" (issue #382): staged connectivity check
    // for ticket/gateway inputs. Never rejects. (Issue #603 deleted the ssh
    // variant along with the whole SSH-connect feature.)
    testGatewayConnection: (
      input:
        | { kind: "ticket"; ticket: string }
        | { kind: "gateway"; gatewayId: string }
    ) => bridge.invoke(Channel.GATEWAY_TEST_CONNECTION, input),
    // Gateway runtime watch: latest heartbeat snapshot for first paint, plus
    // the per-poll push stream the Gateway page (and sidebar pill) subscribe to.
    getGatewayRuntime: () => bridge.invoke(Channel.GATEWAY_RUNTIME_GET),
    onGatewayRuntime: (cb: (snapshot: unknown) => void) =>
      subscribe(bridge, Channel.GATEWAY_RUNTIME_EVENT, cb),
    // Gateway ops (issue #351). Restart applies to the local embedded gateway
    // only (remote gateways restart server-side); diagnostics export fetches
    // the active gateway's bundle and saves it via a native dialog.
    restartGateway: () => bridge.invoke(Channel.GATEWAY_RESTART),
    // The startup error screen's "Try again": clears the supervisor's give-up
    // state and re-attempts the local gateway START. Separate from
    // `restartGateway` because that one resolves the active gateway first,
    // which is the call that fails when there is nothing to restart yet.
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

    // Vault addressing (issue #289): switch the vault this client addresses on
    // the active gateway. A pure client-side pointer flip — no server call.
    setActiveVault: (input: { vaultId?: string }) =>
      bridge.invoke(Channel.VAULTS_SET_ACTIVE, input),
    // Owner-scoped vault create/erase on the local gateway.
    createVault: (input: { name?: string }) =>
      bridge.invoke(Channel.VAULTS_CREATE, input),
    deleteVault: (input: { vaultId: string; name: string }) =>
      bridge.invoke(Channel.VAULTS_DELETE, input),
    // Notify-only: call after a metadata-only `updateVault()` HTTP call
    // succeeds so every window's `onVaultMetadataChanged` listeners (sidebar
    // head) re-read immediately instead of waiting on an unrelated event.
    // Deliberately separate from VAULT_CHANGED — no addressing changed here,
    // so this must not trigger `reScope`'s navigate-Home in App.tsx.
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

    // Templates, app chat, gateway-side user identity + prefs, coding-agent
    // detection, and the whole automations surface all moved to the
    // renderer's direct HTTP clients under the thin-client pivot — see
    // `renderer/gateway-client.ts` and `gateway-client-conversation.ts`.

    // Phone link (issue #263) — the Settings → Phone panel drives the
    // main-process iroh tunnel: status + device list, one-time pairing QR,
    // and per-device revocation. Pairing completion arrives as a broadcast.
    getPhoneLinkStatus: () => bridge.invoke(Channel.PHONE_STATUS),
    beginPhonePairing: () => bridge.invoke(Channel.PHONE_BEGIN_PAIRING),
    cancelPhonePairing: () => bridge.invoke(Channel.PHONE_CANCEL_PAIRING),
    revokePhoneDevice: (input: { deviceId: string }) =>
      bridge.invoke(Channel.PHONE_REVOKE, input),
    onPhonePaired: (cb: (msg: { device: unknown }) => void) =>
      subscribe(bridge, Channel.PHONE_PAIRED, cb),

    // Relaunch to update — the main process watches the built dist for a newer
    // build landing while the app runs; the sidebar pill snapshots the status,
    // subscribes to the broadcast, and triggers the relaunch.
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

    // Keychain pre-write note (issue #603): true when starting the local
    // gateway on THIS host is expected to pop an OS credential prompt, so the
    // first-run chooser can say so before the dialog appears.
    keychainPromptExpected: (): Promise<boolean> =>
      bridge.invoke(Channel.KEYCHAIN_PROMPT_EXPECTED) as Promise<boolean>,

    // "What's new" changelog — main fetches the project's GitHub Releases
    // (cached) and returns the running build's version plus the release list.
    getChangelog: () => bridge.invoke(Channel.CHANGELOG_GET),
  };
}

/**
 * Build the `window.CentraidTokens` object — a pure projection of the shared
 * design-token package. Arrays are copied so the renderer cannot mutate the
 * package's frozen-by-convention exports through the bridge, and `toCss()` is
 * evaluated once here (it is pure and stable for the lifetime of the build,
 * and the renderer's `theme-vars.ts` injects the string into a <style> tag).
 *
 * `fontFaceCss` is `@centraid/design/fonts`' `toFontFaceCss()` output, already
 * pointed at wherever THIS host serves the vendored `.woff2` files. It is
 * concatenated AHEAD of the token CSS rather than shipped as a second field:
 * `theme-vars.ts` prepends `cssText` as one <style> before anything resolves
 * `--font-sans`, and a face declared after the first `var()` lookup would let
 * the shell paint one frame in the UA default. One string, one injection.
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
    // Ordered list of theme presets the picker renders. Includes label +
    // kind ('light' | 'dark'); the renderer derives swatch previews from
    // `themes[name]` so this stays metadata-only.
    themePresets: [...tokens.THEME_PRESETS],
    // `tileFinish` is pure — exposing the function lets the renderer compute
    // a tile's background/glyph/shadow without duplicating the variant rules
    // in CSS. Functions cross the contextBridge fine when wrapped this way.
    tileFinish: (color: string, variant: DesignTokens.TileVariant) =>
      tokens.tileFinish(color, variant),
    type: tokens.type,
  };
}
