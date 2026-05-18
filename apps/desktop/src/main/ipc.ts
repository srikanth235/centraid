import { ipcMain, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadSettings, saveSettings, templatesCacheDir, type DesktopSettings } from './settings.js';
import { PREVIEW_SCHEME } from './preview-protocol.js';
import { refreshAuthInjector } from './auth-injector.js';
import { resetChatHistoryAuthCache } from './chat-history-client.js';
import {
  fetchUserId,
  fetchUserPrefs,
  saveUserPrefs,
  resetUserPrefsAuthCache,
} from './user-prefs-client.js';
import {
  importAvailableCreds,
  readAuthStatus,
  type AuthImportResult,
  type AuthStatus,
} from './auth-import.js';

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

  AUTH_STATUS: 'centraid:auth:status',
  AUTH_RESYNC: 'centraid:auth:resync',

  // Gateway-side user identity + global preferences (theme, density, accent…).
  // These read/write the centraid-user.sqlite that the runtime exposes at
  // `/_centraid-user/*` — same file regardless of local vs. remote gateway.
  USER_ID_GET: 'centraid:user:id',
  USER_PREFS_GET: 'centraid:user:prefs:get',
  USER_PREFS_SAVE: 'centraid:user:prefs:save',
} as const;

interface AgentSessionHandle {
  projectId: string;
  projectDir: string;
  prompt(text: string): Promise<void>;
  stop(): Promise<void>;
}

const sessions = new Map<number, AgentSessionHandle>();

async function loadRunnerPrefs(): Promise<{
  kind: 'codex' | 'claude-code';
  binPath?: string;
  extraArgs?: string[];
}> {
  const prefs = await fetchUserPrefs();
  const kindRaw = prefs['agent.runner.kind'];
  const kind: 'codex' | 'claude-code' | undefined =
    kindRaw === 'codex' || kindRaw === 'claude-code' ? kindRaw : undefined;
  if (!kind) {
    throw new Error(
      'No coding agent configured. Open Settings → AI providers and pick Codex or Claude Code.',
    );
  }
  const binPath =
    typeof prefs['agent.runner.binPath'] === 'string'
      ? (prefs['agent.runner.binPath'] as string)
      : undefined;
  const extraArgsRaw = prefs['agent.runner.extraArgs'];
  const extraArgs = Array.isArray(extraArgsRaw)
    ? (extraArgsRaw.filter((v) => typeof v === 'string') as string[])
    : undefined;
  return {
    kind,
    ...(binPath ? { binPath } : {}),
    ...(extraArgs ? { extraArgs } : {}),
  };
}

export function registerIpcHandlers(): void {
  // ----- Settings -----
  ipcMain.handle(Channel.SETTINGS_GET, async () => loadSettings());
  ipcMain.handle(Channel.SETTINGS_SAVE, async (_e, patch: Partial<DesktopSettings>) => {
    const next = await saveSettings(patch);
    // gatewayUrl/token may have flipped; invalidate the per-client auth caches
    // so the next request picks up the new values.
    resetChatHistoryAuthCache();
    resetUserPrefsAuthCache();
    await refreshAuthInjector();
    return next;
  });

  // ----- User identity + prefs (gateway-backed) -----
  ipcMain.handle(Channel.USER_ID_GET, async () => fetchUserId());
  ipcMain.handle(Channel.USER_PREFS_GET, async () => fetchUserPrefs());
  ipcMain.handle(Channel.USER_PREFS_SAVE, async (_e, patch: Record<string, unknown>) =>
    saveUserPrefs(patch),
  );

  // ----- Credential import (Claude Code / Codex → pi auth.json) -----
  // Status read is silent; the resync handler runs the importer with
  // overwrite=true so the user can refresh after rotating their tokens.
  ipcMain.handle(Channel.AUTH_STATUS, async (): Promise<AuthStatus> => readAuthStatus());
  ipcMain.handle(Channel.AUTH_RESYNC, async (): Promise<AuthImportResult> => {
    const result = await importAvailableCreds({ overwrite: true });
    await saveSettings({ authImportedAt: new Date().toISOString() });
    return result;
  });

  // ----- Projects -----
  ipcMain.handle(Channel.PROJECTS_LIST, async () => {
    const settings = await loadSettings();
    const { listProjects } = await import('@centraid/builder-harness');
    return listProjects(settings.projectsDir);
  });

  ipcMain.handle(
    Channel.PROJECTS_CREATE,
    async (_e, input: { id: string; name?: string; version?: string }) => {
      const settings = await loadSettings();
      const { scaffoldProject } = await import('@centraid/builder-harness');
      return scaffoldProject(settings.projectsDir, input.id, {
        name: input.name,
        version: input.version,
      });
    },
  );

  ipcMain.handle(Channel.PROJECTS_FILES, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { readProjectFiles } = await import('@centraid/builder-harness');
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
    const { deleteProject } = await import('@centraid/builder-harness');
    await deleteProject(settings.projectsDir, input.id);
    return { ok: true };
  });

  ipcMain.handle(
    Channel.PROJECTS_UPDATE_META,
    async (_e, input: { id: string; name?: string; description?: string }) => {
      const settings = await loadSettings();
      const { updateProjectMeta } = await import('@centraid/builder-harness');
      await updateProjectMeta(settings.projectsDir, input.id, {
        name: input.name,
        description: input.description,
      });
      return { ok: true };
    },
  );

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
      const { createCentraidAgentSession } = await import('@centraid/builder-harness');
      const projectDir = path.join(settings.projectsDir, input.projectId);

      const runnerPrefs = await loadRunnerPrefs();

      const session = await createCentraidAgentSession({
        projectDir,
        runnerPrefs,
        sessionMode: input.sessionMode,
        liveSchema: { config: settings, appId: input.projectId },
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
        projectDir,
        prompt: async (text: string) => {
          // Refresh the preview snapshot the agent reads via its native
          // `Read` tool / `centraid preview snapshot`. Best-effort —
          // capture errors (preview tab not visible, no index.html yet)
          // shouldn't block the turn; the snapshot subcommand will just
          // report `exists: false` and the agent can adapt.
          await capturePreviewSnapshot(win, projectDir).catch(() => undefined);
          await session.prompt(text);
        },
        stop: async () => {
          session.abort();
          unsubscribe();
          sessions.delete(win.id);
        },
      });

      // The new runtime doesn't replay persisted message history — the
      // backend (codex thread / Claude session) keeps the model-visible
      // transcript across reloads via its own resume mechanism, while
      // the renderer always starts with an empty chat pane.
      return { ok: true, messages: [] };
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
    const { publishProject } = await import('@centraid/builder-harness');
    const projectDir = path.join(settings.projectsDir, input.id);
    return publishProject(projectDir, input.id, settings, {
      skipBuild: input.skipBuild,
    });
  });

  ipcMain.handle(Channel.VERSIONS_LIST, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { listVersions, HarnessError } = await import('@centraid/builder-harness');
    try {
      return await listVersions(settings, input.id);
    } catch (err) {
      // 404 = app not registered, 409 = path-mode (no versioning). Both are
      // the "never published" probe result the renderer expects — collapse to
      // an empty list rather than rejecting (which Electron logs noisily).
      if (err instanceof HarnessError && (err.code === 'not_found' || err.code === 'conflict')) {
        return { versions: [] };
      }
      throw err;
    }
  });

  ipcMain.handle(
    Channel.VERSIONS_ACTIVATE,
    async (_e, input: { id: string; versionId: string }) => {
      const settings = await loadSettings();
      const { activateVersion } = await import('@centraid/builder-harness');
      return activateVersion(settings, input.id, input.versionId);
    },
  );

  ipcMain.handle(Channel.APP_LIVE_URL, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { appLiveUrl } = await import('@centraid/builder-harness');
    return { url: appLiveUrl(settings, input.id) };
  });

  // Live schema for the Cloud → Database panel. Returns `undefined` when
  // the gateway has nothing for this app yet (404 / 503 / 409 from the
  // schema endpoint — see fetchAppSchema for the exact semantics).
  ipcMain.handle(Channel.APP_SCHEMA, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { fetchAppSchema } = await import('@centraid/builder-harness');
    return fetchAppSchema(settings, input.id);
  });

  // Cloud → Database row browser. Pulls one page of rows (default 50,
  // capped at 200 server-side) from the named table.
  ipcMain.handle(
    Channel.APP_TABLE_ROWS,
    async (_e, input: { id: string; table: string; limit?: number; offset?: number }) => {
      const settings = await loadSettings();
      const { fetchAppTableRows } = await import('@centraid/builder-harness');
      return fetchAppTableRows(settings, input.id, input.table, {
        limit: input.limit,
        offset: input.offset,
      });
    },
  );

  // Cloud → SQL editor. Single-statement; gateway distinguishes
  // SELECT-style ({ kind: 'rows' }) from DML/DDL ({ kind: 'exec' }).
  ipcMain.handle(Channel.APP_QUERY, async (_e, input: { id: string; sql: string }) => {
    const settings = await loadSettings();
    const { runAppQuery } = await import('@centraid/builder-harness');
    return runAppQuery(settings, input.id, input.sql);
  });

  // Cloud → Logs. Newest-first tail with optional `sinceTs` for polling.
  ipcMain.handle(
    Channel.APP_LOGS,
    async (
      _e,
      input: { id: string; limit?: number; sinceTs?: number; level?: 'info' | 'warn' | 'error' },
    ) => {
      const settings = await loadSettings();
      const { fetchAppLogs } = await import('@centraid/builder-harness');
      return fetchAppLogs(settings, input.id, {
        limit: input.limit,
        sinceTs: input.sinceTs,
        level: input.level,
      });
    },
  );

  ipcMain.handle(Channel.APPS_DEREGISTER, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { deregisterApp } = await import('@centraid/builder-harness');
    return deregisterApp(settings, input.id);
  });

  // ----- Templates -----
  ipcMain.handle(Channel.TEMPLATES_LIST, async () => {
    const { resolveTemplates } = await import('@centraid/app-templates');
    // Strip `files` + `source` from the wire response — the renderer only
    // needs the display metadata, and the lists can be sizable.
    const resolved = await resolveTemplates({ cacheDir: templatesCacheDir() });
    return resolved.map((t) => ({
      id: t.id,
      name: t.name,
      desc: t.desc,
      colorKey: t.colorKey,
      iconKey: t.iconKey,
      version: t.version,
    }));
  });

  ipcMain.handle(
    Channel.TEMPLATES_CLONE,
    async (_e, input: { templateId: string; newAppId?: string; newName?: string }) => {
      const settings = await loadSettings();
      const { resolveTemplates, templateSourceDir } = await import('@centraid/app-templates');
      const { cloneTemplate, suggestAppId } = await import('@centraid/builder-harness');

      const cacheDir = templatesCacheDir();
      const templates = await resolveTemplates({ cacheDir });
      const tmpl = templates.find((t) => t.id === input.templateId);
      if (!tmpl) {
        throw new Error(`Unknown template "${input.templateId}".`);
      }

      // Default clones always get a suffixed id (e.g. `todos-2`) so the
      // template's bare id (`todos`) is never consumed by a clone — keeps
      // the catalog and the user's workspace cleanly separated. Caller can
      // pass an explicit `newAppId` to override and claim any free id.
      const newAppId = await suggestAppId(settings.projectsDir, input.newAppId ?? tmpl.id, {
        alwaysSuffix: !input.newAppId,
      });

      const project = await cloneTemplate({
        projectsDir: settings.projectsDir,
        newAppId,
        // The resolver tells us which copy is newer (cache vs bundle); clone
        // from that one so a remote update reaches users without a desktop
        // release.
        templateDir: templateSourceDir(tmpl.id, { cacheDir, source: tmpl.source }),
        newName: input.newName ?? tmpl.name,
        // Carry the template's description into the cloned project's
        // `app.json` so the builder topbar + home tile show something
        // meaningful out of the gate.
        newDesc: tmpl.desc,
      });

      // Cloning only lays the project down on disk as a draft. The user
      // edits/previews in the builder and explicitly clicks Publish to
      // upload to the gateway (Channel.PUBLISH).
      return {
        project,
        template: {
          id: tmpl.id,
          name: tmpl.name,
          desc: tmpl.desc,
          colorKey: tmpl.colorKey,
          iconKey: tmpl.iconKey,
          version: tmpl.version,
        },
      };
    },
  );
}

/**
 * Capture the preview iframe inside `win` and write it as a PNG to
 * `<projectDir>/.preview/snapshot.png`. The agent picks it up via its
 * native `Read` tool (or `centraid preview snapshot` for freshness
 * metadata).
 *
 * The renderer tags the preview iframe with `data-centraid-app="1"`;
 * we use `executeJavaScript` to read its bounding rect, then clip
 * `capturePage` to that region so the agent sees the app, not the
 * surrounding chrome. Failures (no preview tab open yet, no
 * `index.html` scaffolded) are reported via the snapshot file's
 * absence — the agent's `centraid preview snapshot` call returns
 * `{ exists: false }` and the agent adapts.
 */
async function capturePreviewSnapshot(win: BrowserWindow, projectDir: string): Promise<void> {
  if (win.isDestroyed()) return;
  const dir = path.join(projectDir, '.preview');
  const file = path.join(dir, 'snapshot.png');
  // Drop any prior snapshot up front so a failed capture (hidden preview tab,
  // missing iframe, capturePage throw) can't leave a stale image the agent
  // then treats as fresh. Re-created below iff capture succeeds this turn.
  await fs.rm(file, { force: true }).catch(() => undefined);

  const rect = (await win.webContents.executeJavaScript(
    `(() => {
      const f = document.querySelector('iframe[data-centraid-app="1"]');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  )) as { x: number; y: number; width: number; height: number } | null;

  if (!rect) return;

  const image = await win.webContents.capturePage({
    x: Math.max(0, Math.round(rect.x)),
    y: Math.max(0, Math.round(rect.y)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, image.toPNG());
}

/** Stop and forget the session associated with a closing window. */
export async function disposeWindowSession(windowId: number): Promise<void> {
  const handle = sessions.get(windowId);
  if (handle) await handle.stop().catch(() => {});
  sessions.delete(windowId);
}
