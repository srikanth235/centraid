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

  // Project create/files/write/delete/update-meta + publish + templates clone
  // + automation create/enable/delete moved to the renderer's direct HTTP
  // client (renderer/gateway-client.ts) under the thin-client pivot. Only the
  // local-only reveal-in-Finder + preview URL stay on IPC.
  PROJECTS_OPEN: 'centraid:projects:open',
  PROJECTS_PREVIEW_URL: 'centraid:projects:preview-url',

  PUBLISH_STATUS: 'centraid:publish:status',
  PUBLISH_EVENT: 'centraid:publish:event',

  // Gateways (issue #109)
  GATEWAYS_LIST: 'centraid:gateways:list',
  GATEWAYS_ADD: 'centraid:gateways:add',
  GATEWAYS_ADD_LOCAL: 'centraid:gateways:add-local',
  GATEWAYS_REMOVE: 'centraid:gateways:remove',
  GATEWAYS_RENAME: 'centraid:gateways:rename',
  GATEWAYS_UPDATE_METADATA: 'centraid:gateways:update-metadata',
  GATEWAYS_UPDATE_TOKEN: 'centraid:gateways:update-token',
  GATEWAYS_SET_ACTIVE: 'centraid:gateways:set-active',
  GATEWAY_CHANGED: 'centraid:gateways:changed',
  GATEWAY_AUTH_GET: 'centraid:gateways:auth',

  AUTH_STATUS: 'centraid:auth:status',
  AUTH_RESYNC: 'centraid:auth:resync',

  PROVIDER_API_KEY_SET: 'centraid:agent:provider:setApiKey',
  PROVIDER_API_KEY_HAS: 'centraid:agent:provider:hasApiKey',
  PROVIDER_API_KEY_CLEAR: 'centraid:agent:provider:clearApiKey',

  RUNNER_STATUS_GET: 'centraid:agent:runner:status',
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
  // Settings
  getSettings: () => ipcRenderer.invoke(Channel.SETTINGS_GET),
  saveSettings: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke(Channel.SETTINGS_SAVE, patch),

  // Projects: list/create/files/write/delete/update-meta moved to the
  // renderer's direct HTTP client (renderer/gateway-client.ts) under the
  // thin-client pivot. Only the local-only reveal-in-Finder + preview URL
  // stay on IPC.
  openProjectFolder: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_OPEN, input),
  previewUrl: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_PREVIEW_URL, input),

  // The in-process AGENT_* builder retired with the unified chat (issue
  // #141, Phase 3): the builder + the app-view data chat both stream the
  // gateway's `/centraid/<id>/_chat` SSE directly via
  // `renderer/gateway-client-chat.ts` — no main-process relay.

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
  // always present; remote gateways have UUID ids. Tokens never cross
  // the bridge back — they're set when adding a gateway and live in
  // keychain thereafter.
  listGateways: () => ipcRenderer.invoke(Channel.GATEWAYS_LIST),
  addGateway: (input: {
    label: string;
    url: string;
    token: string;
    displayName?: string;
    avatarColor?: string;
  }) => ipcRenderer.invoke(Channel.GATEWAYS_ADD, input),
  addLocalGateway: (input: { label: string; displayName?: string; avatarColor?: string }) =>
    ipcRenderer.invoke(Channel.GATEWAYS_ADD_LOCAL, input),
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
  onGatewayChanged: (
    cb: (msg: {
      activeGatewayId: string;
      activeGatewayKind: 'local' | 'remote';
      activeGatewayLabel: string;
      activeProfileDisplayName: string;
      activeProfileAvatarColor: string;
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
        },
      );
    ipcRenderer.on(Channel.GATEWAY_CHANGED, handler);
    return () => ipcRenderer.off(Channel.GATEWAY_CHANGED, handler);
  },

  // Templates: list + clone moved to the renderer's direct HTTP client —
  // the gateway owns the catalog (`GET /centraid/_templates`) + clone
  // (`POST /centraid/_apps/_clone`).

  // App chat (turn streaming + history) moved to the renderer's direct HTTP
  // client (`renderer/gateway-client-chat.ts`): the panel streams
  // `/centraid/<appId>/_chat` SSE itself and reads/writes history over the
  // gateway's `/_centraid-chat` surface — no main-process relay.

  // Credential import (Claude Code / Codex → pi auth.json)
  authStatus: () => ipcRenderer.invoke(Channel.AUTH_STATUS),
  authResync: () => ipcRenderer.invoke(Channel.AUTH_RESYNC),

  // Gateway-side user identity + global prefs (centraid-user.sqlite) moved
  // to the renderer's direct HTTP client (renderer/gateway-client.ts) under
  // the thin-client pivot — pure `/_centraid-user` reads/writes.

  // Custom OpenAI-compatible provider — API key persisted via Electron
  // safeStorage in the main process. Renderer can write, check presence,
  // or clear; it can never read the plaintext back.
  setProviderApiKey: (input: { apiKey: string }) =>
    ipcRenderer.invoke(Channel.PROVIDER_API_KEY_SET, input),
  hasProviderApiKey: () => ipcRenderer.invoke(Channel.PROVIDER_API_KEY_HAS),
  clearProviderApiKey: () => ipcRenderer.invoke(Channel.PROVIDER_API_KEY_CLEAR),

  // Fresh preflight — re-probes the binary and (if configured) the
  // custom OpenAI-compatible endpoint. Renderer calls this when the
  // settings panel opens or the user clicks "Test connection".
  getRunnerStatus: () => ipcRenderer.invoke(Channel.RUNNER_STATUS_GET),

  // Automations: create/enable/delete + the read/run/analytics surface +
  // insights moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) under the thin-client pivot — the gateway
  // owns scaffold + webhook mint + stage + publish.
});
