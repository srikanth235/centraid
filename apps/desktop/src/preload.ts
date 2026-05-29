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

  PROJECTS_CREATE: 'centraid:projects:create',
  PROJECTS_FILES: 'centraid:projects:files',
  PROJECTS_WRITE_FILE: 'centraid:projects:write-file',
  PROJECTS_OPEN: 'centraid:projects:open',
  PROJECTS_DELETE: 'centraid:projects:delete',
  PROJECTS_UPDATE_META: 'centraid:projects:update-meta',
  PROJECTS_PREVIEW_URL: 'centraid:projects:preview-url',

  AGENT_START: 'centraid:agent:start',
  AGENT_PROMPT: 'centraid:agent:prompt',
  AGENT_STOP: 'centraid:agent:stop',
  AGENT_EVENT: 'centraid:agent:event',

  PUBLISH: 'centraid:publish',
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

  TEMPLATES_LIST: 'centraid:templates:list',
  TEMPLATES_CLONE: 'centraid:templates:clone',

  CHAT_START: 'centraid:chat:start',
  CHAT_SEND: 'centraid:chat:send',
  CHAT_ABORT: 'centraid:chat:abort',
  CHAT_EVENT: 'centraid:chat:event',
  CHAT_MODELS: 'centraid:chat:models',
  CHAT_HISTORY_LIST: 'centraid:chat:history:list',
  CHAT_HISTORY_LOAD: 'centraid:chat:history:load',
  CHAT_HISTORY_DELETE: 'centraid:chat:history:delete',
  CHAT_HISTORY_RENAME: 'centraid:chat:history:rename',

  AUTH_STATUS: 'centraid:auth:status',
  AUTH_RESYNC: 'centraid:auth:resync',

  PROVIDER_API_KEY_SET: 'centraid:agent:provider:setApiKey',
  PROVIDER_API_KEY_HAS: 'centraid:agent:provider:hasApiKey',
  PROVIDER_API_KEY_CLEAR: 'centraid:agent:provider:clearApiKey',

  RUNNER_STATUS_GET: 'centraid:agent:runner:status',

  // Automations (issue #91). Only the create/enable/delete mutators stay on
  // IPC (scaffold + editing session + publish orchestration); the read/run/
  // analytics surface + insights moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) under the thin-client pivot.
  AUTOMATIONS_CREATE: 'centraid:automations:create',
  AUTOMATIONS_SET_ENABLED: 'centraid:automations:set-enabled',
  AUTOMATIONS_DELETE: 'centraid:automations:delete',
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

  // Projects (listProjects moved to the renderer's direct HTTP client —
  // a pure `GET /centraid/_apps` registry read)
  createProject: (input: { id: string; name?: string; version?: string }) =>
    ipcRenderer.invoke(Channel.PROJECTS_CREATE, input),
  readProjectFiles: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_FILES, input),
  writeProjectFile: (input: { id: string; path: string; content: string }) =>
    ipcRenderer.invoke(Channel.PROJECTS_WRITE_FILE, input),
  openProjectFolder: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_OPEN, input),
  deleteProject: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_DELETE, input),
  updateProjectMeta: (input: { id: string; name?: string; description?: string }) =>
    ipcRenderer.invoke(Channel.PROJECTS_UPDATE_META, input),
  previewUrl: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_PREVIEW_URL, input),

  // Agent (one session per window)
  startAgent: (input: {
    projectId: string;
    projectKind?: 'app' | 'automation';
    sessionMode?: 'fresh' | 'continue' | 'in-memory';
  }) => ipcRenderer.invoke(Channel.AGENT_START, input),
  promptAgent: (input: { text: string }) => ipcRenderer.invoke(Channel.AGENT_PROMPT, input),
  stopAgent: () => ipcRenderer.invoke(Channel.AGENT_STOP),
  onAgentEvent: (cb: (msg: { projectId: string; event: unknown }) => void) => {
    const handler = (_e: IpcRendererEvent, msg: unknown) =>
      cb(msg as { projectId: string; event: unknown });
    ipcRenderer.on(Channel.AGENT_EVENT, handler);
    return () => ipcRenderer.off(Channel.AGENT_EVENT, handler);
  },

  // Publish
  publish: (input: { id: string; skipBuild?: boolean }) =>
    ipcRenderer.invoke(Channel.PUBLISH, input),
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

  // Templates
  listTemplates: () => ipcRenderer.invoke(Channel.TEMPLATES_LIST),
  cloneTemplate: (input: { templateId: string }) =>
    ipcRenderer.invoke(Channel.TEMPLATES_CLONE, input),

  // App-scoped agentic chat
  chatStart: (input: {
    appId: string;
    appName: string;
    sessionId?: string | null;
    title?: string;
  }) => ipcRenderer.invoke(Channel.CHAT_START, input),
  chatSend: (input: { appId: string; text: string; turnId: number; model?: string }) =>
    ipcRenderer.invoke(Channel.CHAT_SEND, input),
  chatAbort: (input: { appId: string }) => ipcRenderer.invoke(Channel.CHAT_ABORT, input),
  listChatModels: () => ipcRenderer.invoke(Channel.CHAT_MODELS),
  onChatEvent: (cb: (msg: unknown) => void) => {
    const handler = (_e: IpcRendererEvent, msg: unknown): void => cb(msg);
    ipcRenderer.on(Channel.CHAT_EVENT, handler);
    return () => ipcRenderer.off(Channel.CHAT_EVENT, handler);
  },
  // App chat history (persisted on the gateway)
  chatHistoryList: (input: { appId: string }) =>
    ipcRenderer.invoke(Channel.CHAT_HISTORY_LIST, input),
  chatHistoryLoad: (input: { appId: string; sessionId: string }) =>
    ipcRenderer.invoke(Channel.CHAT_HISTORY_LOAD, input),
  chatHistoryDelete: (input: { appId: string; sessionId: string }) =>
    ipcRenderer.invoke(Channel.CHAT_HISTORY_DELETE, input),
  chatHistoryRename: (input: { appId: string; sessionId: string; title: string }) =>
    ipcRenderer.invoke(Channel.CHAT_HISTORY_RENAME, input),

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

  // Automations (issue #91) — create/enable/delete mutators. The read/run/
  // analytics surface + insights moved to the renderer's direct HTTP client.
  createAutomation: (input: {
    id: string;
    name?: string;
    description?: string;
    prompt?: string;
    triggers?: Array<{ kind: 'cron'; expr: string } | { kind: 'webhook' }>;
    apps?: string[];
    model?: string;
    historyKeep?: { count: number } | { days: number } | 'all' | 'errors';
    onFailure?: string;
    enabled?: boolean;
  }) => ipcRenderer.invoke(Channel.AUTOMATIONS_CREATE, input),
  setAutomationEnabled: (input: { automationId: string; enabled: boolean }) =>
    ipcRenderer.invoke(Channel.AUTOMATIONS_SET_ENABLED, input),
  deleteAutomation: (input: { automationId: string }) =>
    ipcRenderer.invoke(Channel.AUTOMATIONS_DELETE, input),
});
