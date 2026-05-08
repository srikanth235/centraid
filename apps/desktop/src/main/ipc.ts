import { ipcMain, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadSettings, saveSettings, type DesktopSettings } from './settings.js';
import { PREVIEW_SCHEME } from './preview-protocol.js';

/**
 * IPC channel names. Keep in sync with `preload.ts` (contextBridge surface)
 * and the renderer-side typings in `renderer/centraid-api.d.ts`.
 */
export const Channel = {
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

interface AgentSessionHandle {
  projectId: string;
  prompt(text: string): Promise<void>;
  stop(): Promise<void>;
}

const sessions = new Map<number, AgentSessionHandle>();

export function registerIpcHandlers(): void {
  // ----- Settings -----
  ipcMain.handle(Channel.SETTINGS_GET, async () => loadSettings());
  ipcMain.handle(Channel.SETTINGS_SAVE, async (_e, patch: Partial<DesktopSettings>) =>
    saveSettings(patch),
  );

  // ----- Projects -----
  ipcMain.handle(Channel.PROJECTS_LIST, async () => {
    const settings = await loadSettings();
    const { listProjects } = await import('@centraid/agent-harness');
    return listProjects(settings.projectsDir);
  });

  ipcMain.handle(
    Channel.PROJECTS_CREATE,
    async (_e, input: { id: string; name?: string; version?: string }) => {
      const settings = await loadSettings();
      const { scaffoldProject } = await import('@centraid/agent-harness');
      return scaffoldProject(settings.projectsDir, input.id, {
        name: input.name,
        version: input.version,
      });
    },
  );

  ipcMain.handle(Channel.PROJECTS_FILES, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { readProjectFiles } = await import('@centraid/agent-harness');
    const dir = path.join(settings.projectsDir, input.id);
    return readProjectFiles(dir);
  });

  ipcMain.handle(Channel.PROJECTS_OPEN, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const dir = path.join(settings.projectsDir, input.id);
    await shell.openPath(dir);
    return { ok: true };
  });

  ipcMain.handle(Channel.PROJECTS_DELETE, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { deleteProject } = await import('@centraid/agent-harness');
    await deleteProject(settings.projectsDir, input.id);
    return { ok: true };
  });

  // Local-files preview URL for an unpublished project. Returns
  // `{ url, available }` where `available` indicates that `index.html`
  // exists on disk (i.e. the iframe will actually render something).
  ipcMain.handle(
    Channel.PROJECTS_PREVIEW_URL,
    async (_e, input: { id: string }): Promise<{ url: string; available: boolean }> => {
      const settings = await loadSettings();
      const indexPath = path.join(settings.projectsDir, input.id, 'index.html');
      const available = await fs
        .stat(indexPath)
        .then((s) => s.isFile())
        .catch(() => false);
      // Cache-bust on each request so the iframe always picks up the latest
      // bytes after the agent writes new files. The path stays the same;
      // only the query string changes.
      const url = `${PREVIEW_SCHEME}://${encodeURIComponent(input.id)}/index.html?t=${Date.now()}`;
      return { url, available };
    },
  );

  // ----- Agent (per-window session) -----
  ipcMain.handle(
    Channel.AGENT_START,
    async (
      event,
      input: { projectId: string; sessionMode?: 'fresh' | 'continue' | 'in-memory' },
    ): Promise<{ ok: true; messages: unknown[] }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('no window for agent session');

      const prior = sessions.get(win.id);
      if (prior) await prior.stop().catch(() => {});

      const settings = await loadSettings();
      const { createCentraidAgentSession } = await import('@centraid/agent-harness');
      const projectDir = path.join(settings.projectsDir, input.projectId);

      const session = await createCentraidAgentSession({
        projectDir,
        sessionMode: input.sessionMode,
      });

      const unsubscribe = session.subscribe((evt) => {
        if (win.isDestroyed()) return;
        win.webContents.send(Channel.AGENT_EVENT, {
          projectId: input.projectId,
          event: evt,
        });
      });

      sessions.set(win.id, {
        projectId: input.projectId,
        prompt: async (text: string) => {
          await session.prompt(text);
        },
        stop: async () => {
          unsubscribe();
          sessions.delete(win.id);
        },
      });

      // For "continue" sessions, return the persisted message history so
      // the renderer can hydrate the chat pane before any new turn streams
      // in. Fresh sessions just return an empty array.
      const messages = (session.messages ?? []) as unknown[];
      return { ok: true, messages };
    },
  );

  ipcMain.handle(Channel.AGENT_PROMPT, async (event, input: { text: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('no window for agent prompt');
    const handle = sessions.get(win.id);
    if (!handle) throw new Error('agent session not started for this window');
    await handle.prompt(input.text);
    return { ok: true };
  });

  ipcMain.handle(Channel.AGENT_STOP, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: true };
    const handle = sessions.get(win.id);
    if (handle) await handle.stop();
    return { ok: true };
  });

  // ----- Publish + versions -----
  ipcMain.handle(Channel.PUBLISH, async (_e, input: { id: string; skipBuild?: boolean }) => {
    const settings = await loadSettings();
    const { publishProject } = await import('@centraid/agent-harness');
    const projectDir = path.join(settings.projectsDir, input.id);
    return publishProject(projectDir, input.id, settings, {
      skipBuild: input.skipBuild,
    });
  });

  ipcMain.handle(Channel.VERSIONS_LIST, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { listVersions } = await import('@centraid/agent-harness');
    return listVersions(settings, input.id);
  });

  ipcMain.handle(
    Channel.VERSIONS_ACTIVATE,
    async (_e, input: { id: string; versionId: string }) => {
      const settings = await loadSettings();
      const { activateVersion } = await import('@centraid/agent-harness');
      return activateVersion(settings, input.id, input.versionId);
    },
  );

  ipcMain.handle(Channel.APP_LIVE_URL, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { appLiveUrl } = await import('@centraid/agent-harness');
    return { url: appLiveUrl(settings, input.id) };
  });

  ipcMain.handle(Channel.APPS_DEREGISTER, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { deregisterApp } = await import('@centraid/agent-harness');
    return deregisterApp(settings, input.id);
  });
}

/** Stop and forget the session associated with a closing window. */
export async function disposeWindowSession(windowId: number): Promise<void> {
  const handle = sessions.get(windowId);
  if (handle) await handle.stop().catch(() => {});
  sessions.delete(windowId);
}
