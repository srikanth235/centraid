// Bridges shared design tokens AND the centraid IPC API into the renderer.
// Renderer runs with contextIsolation=true and no node integration. We expose
// JSON-cloneable values + IPC proxies via contextBridge.
//
// This file is bundled to CJS by `bun build` (Electron `sandbox: true` requires
// CJS preload). Renderer typings live in `renderer/centraid-api.d.ts`.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import * as tokens from '@centraid/design-tokens';

const Channel = {
  SETTINGS_GET: 'centraid:settings:get',
  SETTINGS_SAVE: 'centraid:settings:save',
  DEVICE_TRANSCRIPT_AVAILABLE: 'centraid:device-transcript:available',
  DEVICE_TRANSCRIBE: 'centraid:device-transcript:run',

  // App create/files/write/delete/update-meta + publish + templates clone
  // + automation create/enable/delete moved to the renderer's direct HTTP
  // client (renderer/gateway-client.ts) under the thin-client pivot. The
  // preview iframe points at the gateway draft URL (Phase 4), so only the
  // local-only reveal-in-Finder stays on IPC.
  APPS_OPEN: 'centraid:apps:open',

  PUBLISH_STATUS: 'centraid:publish:status',
  PUBLISH_EVENT: 'centraid:publish:event',

  // Gateways (issue #109)
  GATEWAYS_LIST: 'centraid:gateways:list',
  GATEWAYS_REMOVE: 'centraid:gateways:remove',
  GATEWAYS_RENAME: 'centraid:gateways:rename',
  GATEWAYS_UPDATE_METADATA: 'centraid:gateways:update-metadata',
  GATEWAYS_UPDATE_TOKEN: 'centraid:gateways:update-token',
  GATEWAYS_SET_ACTIVE: 'centraid:gateways:set-active',
  GATEWAY_CHANGED: 'centraid:gateways:changed',
  GATEWAY_AUTH_GET: 'centraid:gateways:auth',
  // Pairing-ticket redemption + per-gateway vault preview (issue #376).
  GATEWAY_PAIR_REDEEM: 'centraid:gateways:pair-redeem',
  GATEWAYS_LIST_VAULTS: 'centraid:gateways:list-vaults',
  // ConnectFlow "handshake ladder" + "Over SSH" commit (issue #382).
  GATEWAY_TEST_CONNECTION: 'centraid:gateways:test-connection',
  GATEWAY_SSH_CONNECT: 'centraid:gateways:ssh-connect',
  // Gateway runtime watch (heartbeat status + outage log + down alert).
  GATEWAY_RUNTIME_GET: 'centraid:gateway-runtime:get',
  GATEWAY_RUNTIME_EVENT: 'centraid:gateway-runtime:event',
  // Gateway ops (issue #351): manual restart of the local embedded gateway
  // + save-dialog export of the gateway's diagnostics bundle.
  GATEWAY_RESTART: 'centraid:gateway-runtime:restart',
  GATEWAY_DIAGNOSTICS_EXPORT: 'centraid:gateway-runtime:export-diagnostics',
  GATEWAY_RECOVERY_KIT_EXPORT: 'centraid:gateway-runtime:export-recovery-kit',
  // Vault addressing (issue #289): client-side active vault per gateway.
  VAULTS_SET_ACTIVE: 'centraid:vaults:set-active',
  VAULT_CHANGED: 'centraid:vaults:changed',
  VAULTS_CREATE: 'centraid:vaults:create',
  VAULTS_DELETE: 'centraid:vaults:delete',
  VAULT_METADATA_CHANGED: 'centraid:vaults:metadata-changed',
  VAULT_METADATA_PUSH: 'centraid:vaults:metadata-push',

  // Phone link (issue #263)
  PHONE_STATUS: 'centraid:phone:status',
  PHONE_BEGIN_PAIRING: 'centraid:phone:begin-pairing',
  PHONE_CANCEL_PAIRING: 'centraid:phone:cancel-pairing',
  PHONE_REVOKE: 'centraid:phone:revoke',
  PHONE_PAIRED: 'centraid:phone:paired',

  // Relaunch to update (dist watcher in main/update-watcher.ts)
  UPDATE_STATUS: 'centraid:update:status',
  UPDATE_CHECK: 'centraid:update:check',
  UPDATE_RELAUNCH: 'centraid:update:relaunch',
  GATEWAY_SERVICE_INSTALL: 'centraid:gateway:service-install',

  UPDATE_AVAILABLE: 'centraid:update:available',

  // "What's new" changelog (main/changelog.ts) — GitHub Releases fetch, cached.
  CHANGELOG_GET: 'centraid:changelog:get',
} as const;

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
  // File ASR is backed by an explicitly configured loopback model service in
  // the main process; capability stays false until that adapter answers.
  getHostCapabilities: async () => {
    const transcript = await ipcRenderer
      .invoke(Channel.DEVICE_TRANSCRIPT_AVAILABLE)
      .then((value) => value === true)
      .catch(() => false);
    return {
      platform: 'desktop' as const,
      appSessions: false,
      compute: {
        previews: true,
        poster: true,
        pdfText: true,
        ocr: false,
        embedding: false,
        transcript,
        edgeSeal: true,
        backgroundTransfer: false,
      },
    };
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
  // always present; remote gateways have UUID ids. Issue #505 phase 7 removed
  // the manual "add by URL + token" bridge — gateways are added through the
  // pairing ceremony (`redeemGatewayPairing`), which adds the profile itself.
  listGateways: () => ipcRenderer.invoke(Channel.GATEWAYS_LIST),
  removeGateway: (input: { id: string }) => ipcRenderer.invoke(Channel.GATEWAYS_REMOVE, input),
  renameGateway: (input: { id: string; label: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_RENAME, input),
  updateProfileMetadata: (input: { id: string; displayName?: string; avatarColor?: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_UPDATE_METADATA, input),
  updateGatewayToken: (input: { id: string; token: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_UPDATE_TOKEN, input),
  setActiveGateway: (input: { id: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_SET_ACTIVE, input),
  // Active gateway's HTTP base URL + bearer token for the renderer's
  // direct data-plane client. Token originates in keychain-backed
  // settings (main); this is the single bridge crossing for it.
  getGatewayAuth: () => ipcRenderer.invoke(Channel.GATEWAY_AUTH_GET),
  // Pairing-ticket redemption (issue #376): decode + dial/POST, add-or-reuse
  // the gateway profile, flip active gateway + active vault together.
  redeemGatewayPairing: (input: {
    ticket: string;
    label?: string;
    mode?: 'auto' | 'iroh' | 'http';
    url?: string;
    rememberDevice?: boolean;
  }) => ipcRenderer.invoke(Channel.GATEWAY_PAIR_REDEEM, input),
  // Preview a gateway's vault list WITHOUT switching to it (issue #376) —
  // the flat (gateway, vault) switcher.
  listGatewayVaults: (input: { gatewayId: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_LIST_VAULTS, input),
  // ConnectFlow "handshake ladder" (issue #382): staged connectivity check
  // for url/ticket/ssh/gateway inputs. Never rejects.
  testGatewayConnection: (
    input:
      | { kind: 'url'; url: string; token?: string }
      | { kind: 'ticket'; ticket: string }
      | { kind: 'ssh'; destination: string; dataDir?: string }
      | { kind: 'gateway'; gatewayId: string },
  ) => ipcRenderer.invoke(Channel.GATEWAY_TEST_CONNECTION, input),
  // ConnectFlow "Over SSH" commit (issue #382): (optional) create a vault
  // remotely, mint+redeem a pairing ticket, persist the ssh block on the
  // resulting profile. On success the active gateway AND vault both flip,
  // same as `redeemGatewayPairing`.
  sshConnectGateway: (input: {
    destination: string;
    dataDir?: string;
    label?: string;
    rememberDevice?: boolean;
    vault: { kind: 'existing'; vaultId: string } | { kind: 'create'; name: string };
  }) => ipcRenderer.invoke(Channel.GATEWAY_SSH_CONNECT, input),
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
  exportGatewayRecoveryKit: () => ipcRenderer.invoke(Channel.GATEWAY_RECOVERY_KIT_EXPORT),
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
  // Vault create/delete — local gateway only (admin plane; remote is server CLI).
  createVault: (input: { name?: string }) => ipcRenderer.invoke(Channel.VAULTS_CREATE, input),
  deleteVault: (input: { vaultId: string }) => ipcRenderer.invoke(Channel.VAULTS_DELETE, input),
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

  // "What's new" changelog — main fetches the project's GitHub Releases
  // (cached) and returns the running build's version plus the release list.
  getChangelog: () => ipcRenderer.invoke(Channel.CHANGELOG_GET),
});
