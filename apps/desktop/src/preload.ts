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
  PROJECTS_PREVIEW_URL: 'centraid:projects:preview-url',

  AGENT_START: 'centraid:agent:start',
  AGENT_PROMPT: 'centraid:agent:prompt',
  AGENT_STOP: 'centraid:agent:stop',
  AGENT_EVENT: 'centraid:agent:event',

  PUBLISH: 'centraid:publish',
  VERSIONS_LIST: 'centraid:versions:list',
  VERSIONS_ACTIVATE: 'centraid:versions:activate',
  APP_LIVE_URL: 'centraid:app:live-url',
  APPS_DEREGISTER: 'centraid:apps:deregister',
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
  deregisterApp: (input: { id: string }) => ipcRenderer.invoke(Channel.APPS_DEREGISTER, input),
});
