// Bridges shared design tokens AND the centraid IPC API into the renderer.
// Renderer runs with contextIsolation=true and no node integration. We expose
// JSON-cloneable values + IPC proxies via contextBridge.
//
// This file is bundled to CJS by `bun build` (Electron `sandbox: true` requires
// CJS preload). Renderer typings live in `renderer/centraid-api.d.ts`.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import * as tokens from '@centraid/design-tokens';
import { Channel, hostCapabilities } from './main/ipc-core.js';
import { createDeepLinkBuffer } from './main/oauth-deep-link.js';

const deepLinkBuffer = createDeepLinkBuffer();
ipcRenderer.on(Channel.DEEP_LINK, (_event: IpcRendererEvent, url: unknown) => {
  if (typeof url === 'string') deepLinkBuffer.push(url);
});

// `tokens.toCss()` is pure and stable for the lifetime of the package
// build, so we precompute it once at preload start. The renderer
// (`theme-vars.ts`) injects this string into a <style> tag — no per-render
// CSS variable writes, no duplicated theme blocks in styles.css.
const tokensCss = tokens.toCss();

contextBridge.exposeInMainWorld('CentraidTokens', {
  apps: [...tokens.apps],
  cssText: tokensCss,
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
  tileFinish: (color: string, variant: tokens.TileVariant) => tokens.tileFinish(color, variant),
  type: tokens.type,
});

contextBridge.exposeInMainWorld('CentraidApi', {
  onDeepLink: (cb: (url: string) => void) => deepLinkBuffer.subscribe(cb),
  // File ASR is backed by an explicitly configured loopback model service in
  // the main process; capability stays false until that adapter answers.
  getHostCapabilities: async () => {
    const transcript = await ipcRenderer
      .invoke(Channel.DEVICE_TRANSCRIPT_AVAILABLE)
      .then((value) => value === true)
      .catch(() => false);
    return hostCapabilities(transcript);
  },
  transcribeMedia: (input: { bytes: ArrayBuffer; mediaType: string; filename?: string }) =>
    ipcRenderer.invoke(Channel.DEVICE_TRANSCRIBE, input),

  // Settings
  getSettings: () => ipcRenderer.invoke(Channel.SETTINGS_GET),
  saveSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke(Channel.SETTINGS_SAVE, patch),

  // Apps: list/create/files/write/delete/update-meta moved to the
  // renderer's direct HTTP client (renderer/gateway-client.ts) under the
  // thin-client pivot. The preview iframe points at the gateway draft URL
  // (Phase 4), so only the local-only reveal-in-Finder stays on IPC.
  openAppFolder: (input: { id: string }) => ipcRenderer.invoke(Channel.APPS_OPEN, input),

  // The in-process AGENT_* builder retired with the unified chat (issue
  // #141, Phase 3): the builder + the app-view data chat both stream the
  // gateway's `/centraid/<id>/_turn` SSE directly via
  // `renderer/gateway-client-conversation.ts` — no main-process relay.

  // Publish moved to the renderer's direct HTTP client (it holds the
  // editing session and POSTs `…/publish`).
  // App read surface (live URL / schema / table rows / SQL / logs /
  // deregister) + version list/activate moved to the renderer's direct HTTP
  // client (renderer/gateway-client.ts) under the thin-client pivot.
  // Auto-publish queue (issue #108) — workspaces upload to the gateway
  // on every save. Renderer can poll a snapshot of the status, or
  // subscribe to per-event broadcasts to toast failures inline.
  getPublishStatus: (input: { id: string }) => ipcRenderer.invoke(Channel.PUBLISH_STATUS, input),
  onPublishEvent: (
    cb: (msg: { id: string; ok: boolean; error?: string; publishedAt?: number }) => void,
  ) => {
    const handler = (_e: IpcRendererEvent, msg: unknown): void =>
      cb(msg as { id: string; ok: boolean; error?: string; publishedAt?: number });
    ipcRenderer.on(Channel.PUBLISH_EVENT, handler);
    return () => ipcRenderer.off(Channel.PUBLISH_EVENT, handler);
  },

  // Gateways (issue #109) — multi-gateway lifecycle. Local gateway is
  // always present; remote gateways use their iroh EndpointId. Issue #505 phase 7 removed
  // the manual "add by URL + token" bridge — gateways are added through the
  // pairing ceremony (`redeemGatewayPairing`), which adds the profile itself.
  listGateways: () => ipcRenderer.invoke(Channel.GATEWAYS_LIST),
  removeGateway: (input: { id: string }) => ipcRenderer.invoke(Channel.GATEWAYS_REMOVE, input),
  renameGateway: (input: { id: string; label: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_RENAME, input),
  updateProfileMetadata: (input: { id: string; displayName?: string; avatarColor?: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_UPDATE_METADATA, input),
  setActiveGateway: (input: { id: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_SET_ACTIVE, input),
  // Active gateway's HTTP base URL + bearer token for the renderer's
  // direct data-plane client. Token originates in keychain-backed
  // settings (main); this is the single bridge crossing for it.
  getGatewayAuth: () => ipcRenderer.invoke(Channel.GATEWAY_AUTH_GET),
  // Pairing-ticket redemption (issue #376): decode + dial/POST, add-or-reuse
  // the gateway profile, flip active gateway + active vault together.
  redeemGatewayPairing: (input: { ticket: string; label?: string; rememberDevice?: boolean }) =>
    ipcRenderer.invoke(Channel.GATEWAY_PAIR_REDEEM, input),
  // Preview a gateway's vault list WITHOUT switching to it (issue #376) —
  // the flat (gateway, vault) switcher.
  listGatewayVaults: (input: { gatewayId: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_LIST_VAULTS, input),
  // ConnectFlow "handshake ladder" (issue #382): staged connectivity check
  // for ticket/gateway inputs. Never rejects. (Issue #603 deleted the ssh
  // variant along with the whole SSH-connect feature.)
  testGatewayConnection: (
    input: { kind: 'ticket'; ticket: string } | { kind: 'gateway'; gatewayId: string },
  ) => ipcRenderer.invoke(Channel.GATEWAY_TEST_CONNECTION, input),
  // Gateway runtime watch: latest heartbeat snapshot for first paint, plus
  // the per-poll push stream the Gateway page (and sidebar pill) subscribe to.
  getGatewayRuntime: () => ipcRenderer.invoke(Channel.GATEWAY_RUNTIME_GET),
  onGatewayRuntime: (cb: (snapshot: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, msg: unknown): void => cb(msg);
    ipcRenderer.on(Channel.GATEWAY_RUNTIME_EVENT, handler);
    return () => ipcRenderer.off(Channel.GATEWAY_RUNTIME_EVENT, handler);
  },
  // Gateway ops (issue #351). Restart applies to the local embedded gateway
  // only (remote gateways restart server-side); diagnostics export fetches
  // the active gateway's bundle and saves it via a native dialog.
  restartGateway: () => ipcRenderer.invoke(Channel.GATEWAY_RESTART),
  exportGatewayDiagnostics: () => ipcRenderer.invoke(Channel.GATEWAY_DIAGNOSTICS_EXPORT),
  exportGatewayRecoveryKit: (input: { password: string }) =>
    ipcRenderer.invoke(Channel.GATEWAY_RECOVERY_KIT_EXPORT, input),
  onGatewayChanged: (
    cb: (msg: {
      activeGatewayId: string;
      activeGatewayKind: 'local' | 'remote';
      activeGatewayLabel: string;
      activeProfileDisplayName: string;
      activeProfileAvatarColor: string;
      gatewayId?: string;
      removedGatewayId?: string;
      purgeReplicaGatewayId?: string;
    }) => void,
  ) => {
    const handler = (_e: IpcRendererEvent, msg: unknown): void =>
      cb(
        msg as {
          activeGatewayId: string;
          activeGatewayKind: 'local' | 'remote';
          activeGatewayLabel: string;
          activeProfileDisplayName: string;
          activeProfileAvatarColor: string;
          gatewayId?: string;
          removedGatewayId?: string;
          purgeReplicaGatewayId?: string;
        },
      );
    ipcRenderer.on(Channel.GATEWAY_CHANGED, handler);
    return () => ipcRenderer.off(Channel.GATEWAY_CHANGED, handler);
  },

  // Vault addressing (issue #289): switch the vault this client addresses on
  // the active gateway. A pure client-side pointer flip — no server call.
  setActiveVault: (input: { vaultId?: string }) =>
    ipcRenderer.invoke(Channel.VAULTS_SET_ACTIVE, input),
  // Owner-scoped vault create/erase on the local gateway.
  createVault: (input: { name?: string }) => ipcRenderer.invoke(Channel.VAULTS_CREATE, input),
  deleteVault: (input: { vaultId: string; name: string }) =>
    ipcRenderer.invoke(Channel.VAULTS_DELETE, input),
  // Notify-only: call after a metadata-only `updateVault()` HTTP call
  // succeeds so every window's `onVaultMetadataChanged` listeners (sidebar
  // head) re-read immediately instead of waiting on an unrelated event.
  // Deliberately separate from VAULT_CHANGED — no addressing changed here,
  // so this must not trigger `reScope`'s navigate-Home in App.tsx.
  notifyVaultMetadataChanged: () => ipcRenderer.invoke(Channel.VAULT_METADATA_CHANGED),
  onVaultChanged: (
    cb: (msg: { activeGatewayId: string; gatewayId?: string; activeVaultId?: string }) => void,
  ) => {
    const handler = (_e: IpcRendererEvent, msg: unknown): void =>
      cb(
        msg as {
          activeGatewayId: string;
          gatewayId?: string;
          activeVaultId?: string;
        },
      );
    ipcRenderer.on(Channel.VAULT_CHANGED, handler);
    return () => ipcRenderer.off(Channel.VAULT_CHANGED, handler);
  },
  onVaultMetadataChanged: (cb: () => void) => {
    const handler = (): void => cb();
    ipcRenderer.on(Channel.VAULT_METADATA_PUSH, handler);
    return () => ipcRenderer.off(Channel.VAULT_METADATA_PUSH, handler);
  },

  // Templates: list + clone moved to the renderer's direct HTTP client —
  // the gateway owns the catalog (`GET /centraid/_templates`) + clone
  // (`POST /centraid/_apps/_clone`).

  // App chat (turn streaming + history) moved to the renderer's direct HTTP
  // client (`renderer/gateway-client-conversation.ts`): the panel streams
  // `/centraid/<appId>/_turn` SSE itself and reads/writes history over the
  // gateway's `/_centraid-conversations` surface — no main-process relay.

  // Gateway-side user identity + global prefs (centraid-user.sqlite) moved
  // to the renderer's direct HTTP client (renderer/gateway-client.ts) under
  // the thin-client pivot — pure `/_centraid-user` reads/writes.
  //
  // Coding-agent detection, the runner preflight, and the custom
  // OpenAI-compatible endpoint config + key moved to the gateway (colocated
  // with the runner): the renderer reads `/centraid/_agents/status` and
  // `/centraid/_turn/runner-status` over HTTP via gateway-client-conversation.ts.

  // Automations: create/enable/delete + the read/run/analytics surface +
  // insights moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) under the thin-client pivot — the gateway
  // owns scaffold + webhook mint + stage + publish.

  // Phone link (issue #263) — the Settings → Phone panel drives the
  // main-process iroh tunnel: status + device list, one-time pairing QR,
  // and per-device revocation. Pairing completion arrives as a broadcast.
  getPhoneLinkStatus: () => ipcRenderer.invoke(Channel.PHONE_STATUS),
  beginPhonePairing: () => ipcRenderer.invoke(Channel.PHONE_BEGIN_PAIRING),
  cancelPhonePairing: () => ipcRenderer.invoke(Channel.PHONE_CANCEL_PAIRING),
  revokePhoneDevice: (input: { deviceId: string }) =>
    ipcRenderer.invoke(Channel.PHONE_REVOKE, input),
  onPhonePaired: (cb: (msg: { device: unknown }) => void) => {
    const handler = (_e: IpcRendererEvent, msg: unknown): void => cb(msg as { device: unknown });
    ipcRenderer.on(Channel.PHONE_PAIRED, handler);
    return () => ipcRenderer.off(Channel.PHONE_PAIRED, handler);
  },

  // Relaunch to update — the main process watches the built dist for a newer
  // build landing while the app runs; the sidebar pill snapshots the status,
  // subscribes to the broadcast, and triggers the relaunch.
  getUpdateStatus: () => ipcRenderer.invoke(Channel.UPDATE_STATUS),
  checkForUpdates: () => ipcRenderer.invoke(Channel.UPDATE_CHECK),
  relaunchToUpdate: () => ipcRenderer.invoke(Channel.UPDATE_RELAUNCH),
  installGatewayService: (): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke(Channel.GATEWAY_SERVICE_INSTALL),

  onUpdateAvailable: (cb: (msg: { available: boolean; version: string }) => void) => {
    const handler = (_e: IpcRendererEvent, msg: unknown): void =>
      cb(msg as { available: boolean; version: string });
    ipcRenderer.on(Channel.UPDATE_AVAILABLE, handler);
    return () => ipcRenderer.off(Channel.UPDATE_AVAILABLE, handler);
  },

  // Keychain pre-write note (issue #603): true when starting the local
  // gateway on THIS host is expected to pop an OS credential prompt, so the
  // first-run chooser can say so before the dialog appears.
  keychainPromptExpected: (): Promise<boolean> =>
    ipcRenderer.invoke(Channel.KEYCHAIN_PROMPT_EXPECTED),

  // "What's new" changelog — main fetches the project's GitHub Releases
  // (cached) and returns the running build's version plus the release list.
  getChangelog: () => ipcRenderer.invoke(Channel.CHANGELOG_GET),
});
