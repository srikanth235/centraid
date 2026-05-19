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

  PROJECTS_LIST: 'centraid:projects:list',
  PROJECTS_CREATE: 'centraid:projects:create',
  PROJECTS_FILES: 'centraid:projects:files',
  PROJECTS_OPEN: 'centraid:projects:open',
  PROJECTS_DELETE: 'centraid:projects:delete',
  PROJECTS_UPDATE_META: 'centraid:projects:update-meta',
  PROJECTS_PREVIEW_URL: 'centraid:projects:preview-url',

  AGENT_START: 'centraid:agent:start',
  AGENT_PROMPT: 'centraid:agent:prompt',
  AGENT_STOP: 'centraid:agent:stop',
  AGENT_EVENT: 'centraid:agent:event',

  PUBLISH: 'centraid:publish',
  VERSIONS_LIST: 'centraid:versions:list',
  VERSIONS_ACTIVATE: 'centraid:versions:activate',
  APP_LIVE_URL: 'centraid:app:live-url',
  APP_SCHEMA: 'centraid:app:schema',
  APP_TABLE_ROWS: 'centraid:app:table-rows',
  APP_QUERY: 'centraid:app:query',
  APP_LOGS: 'centraid:app:logs',
  APPS_DEREGISTER: 'centraid:apps:deregister',

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

  USER_ID_GET: 'centraid:user:id',
  USER_PREFS_GET: 'centraid:user:prefs:get',
  USER_PREFS_SAVE: 'centraid:user:prefs:save',

  PROVIDER_API_KEY_SET: 'centraid:agent:provider:setApiKey',
  PROVIDER_API_KEY_HAS: 'centraid:agent:provider:hasApiKey',
  PROVIDER_API_KEY_CLEAR: 'centraid:agent:provider:clearApiKey',

  RUNNER_STATUS_GET: 'centraid:agent:runner:status',

  // Automations (issue #70). The desktop reads the per-gateway
  // `automations` mirror table and triggers manual runs via the
  // headless `centraid run-automation` path. Reads route through the
  // openclaw plugin's HTTP surface; the run-now action invokes the
  // local CLI in-process for fast iteration.
  AUTOMATIONS_LIST: 'centraid:automations:list',
  AUTOMATIONS_RUN_NOW: 'centraid:automations:run-now',
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
  colors: tokens.colors,
  // `themes` is the new canonical surface; `colors` (light) stays exposed
  // for the existing call sites until they migrate.
  cssText: tokensCss,
  fonts: tokens.fonts,
  icons: tokens.icons,
  palette: tokens.palette,
  radii: tokens.radii,
  spacing: tokens.spacing,
  themes: tokens.themes,
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

  // Projects
  listProjects: () => ipcRenderer.invoke(Channel.PROJECTS_LIST),
  createProject: (input: { id: string; name?: string; version?: string }) =>
    ipcRenderer.invoke(Channel.PROJECTS_CREATE, input),
  readProjectFiles: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_FILES, input),
  openProjectFolder: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_OPEN, input),
  deleteProject: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_DELETE, input),
  updateProjectMeta: (input: { id: string; name?: string; description?: string }) =>
    ipcRenderer.invoke(Channel.PROJECTS_UPDATE_META, input),
  previewUrl: (input: { id: string }) => ipcRenderer.invoke(Channel.PROJECTS_PREVIEW_URL, input),

  // Agent (one session per window)
  startAgent: (input: { projectId: string; sessionMode?: 'fresh' | 'continue' | 'in-memory' }) =>
    ipcRenderer.invoke(Channel.AGENT_START, input),
  promptAgent: (input: { text: string }) => ipcRenderer.invoke(Channel.AGENT_PROMPT, input),
  stopAgent: () => ipcRenderer.invoke(Channel.AGENT_STOP),
  onAgentEvent: (cb: (msg: { projectId: string; event: unknown }) => void) => {
    const handler = (_e: IpcRendererEvent, msg: unknown) =>
      cb(msg as { projectId: string; event: unknown });
    ipcRenderer.on(Channel.AGENT_EVENT, handler);
    return () => ipcRenderer.off(Channel.AGENT_EVENT, handler);
  },

  // Publish + versions
  publish: (input: { id: string; skipBuild?: boolean }) =>
    ipcRenderer.invoke(Channel.PUBLISH, input),
  listVersions: (input: { id: string }) => ipcRenderer.invoke(Channel.VERSIONS_LIST, input),
  activateVersion: (input: { id: string; versionId: string }) =>
    ipcRenderer.invoke(Channel.VERSIONS_ACTIVATE, input),
  appLiveUrl: (input: { id: string }) => ipcRenderer.invoke(Channel.APP_LIVE_URL, input),
  appSchema: (input: { id: string }) => ipcRenderer.invoke(Channel.APP_SCHEMA, input),
  appTableRows: (input: { id: string; table: string; limit?: number; offset?: number }) =>
    ipcRenderer.invoke(Channel.APP_TABLE_ROWS, input),
  appQuery: (input: { id: string; sql: string }) => ipcRenderer.invoke(Channel.APP_QUERY, input),
  appLogs: (input: {
    id: string;
    limit?: number;
    sinceTs?: number;
    level?: 'info' | 'warn' | 'error';
  }) => ipcRenderer.invoke(Channel.APP_LOGS, input),
  deregisterApp: (input: { id: string }) => ipcRenderer.invoke(Channel.APPS_DEREGISTER, input),

  // Templates
  listTemplates: () => ipcRenderer.invoke(Channel.TEMPLATES_LIST),
  cloneTemplate: (input: { templateId: string; newAppId?: string; newName?: string }) =>
    ipcRenderer.invoke(Channel.TEMPLATES_CLONE, input),

  // App-scoped agentic chat
  chatStart: (input: { appId: string; appName: string; sessionId?: string | null }) =>
    ipcRenderer.invoke(Channel.CHAT_START, input),
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
  chatHistoryLoad: (input: { sessionId: string }) =>
    ipcRenderer.invoke(Channel.CHAT_HISTORY_LOAD, input),
  chatHistoryDelete: (input: { sessionId: string }) =>
    ipcRenderer.invoke(Channel.CHAT_HISTORY_DELETE, input),
  chatHistoryRename: (input: { sessionId: string; title: string }) =>
    ipcRenderer.invoke(Channel.CHAT_HISTORY_RENAME, input),

  // Credential import (Claude Code / Codex → pi auth.json)
  authStatus: () => ipcRenderer.invoke(Channel.AUTH_STATUS),
  authResync: () => ipcRenderer.invoke(Channel.AUTH_RESYNC),

  // Gateway-side user identity + global prefs (centraid-user.sqlite). The
  // renderer treats the gateway as source of truth and keeps the local
  // Store value as a fast-paint cache only.
  getUserId: () => ipcRenderer.invoke(Channel.USER_ID_GET),
  getUserPrefs: () => ipcRenderer.invoke(Channel.USER_PREFS_GET),
  saveUserPrefs: (patch: Record<string, unknown>) =>
    ipcRenderer.invoke(Channel.USER_PREFS_SAVE, patch),

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

  // Automations (issue #70).
  listAutomations: (input: { appId: string }) =>
    ipcRenderer.invoke(Channel.AUTOMATIONS_LIST, input),
  runAutomationNow: (input: { appId: string; name: string }) =>
    ipcRenderer.invoke(Channel.AUTOMATIONS_RUN_NOW, input),
  setAutomationEnabled: (input: { appId: string; name: string; enabled: boolean }) =>
    ipcRenderer.invoke(Channel.AUTOMATIONS_SET_ENABLED, input),
  deleteAutomation: (input: { appId: string; name: string }) =>
    ipcRenderer.invoke(Channel.AUTOMATIONS_DELETE, input),
});
