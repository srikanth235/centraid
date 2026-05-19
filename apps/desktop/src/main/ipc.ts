// governance: allow-repo-hygiene file-size-limit ipc-hub pending split per-feature handler modules (agent, chat, projects, provider) once the surface stabilizes
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
import {
  localRuntimeAppsDir,
  localRuntimeAutomationHost,
  localRuntimeCodexHomeBaseDir,
  localRuntimeGatewayDb,
  noteRunnerPrefsChanged,
  resolveProviderPrefs,
} from './local-runtime.js';
import {
  runPreflight,
  runAutomationLocal,
  type OpenAICompatProvider,
  type RunnerPrefs,
} from '@centraid/agent-runtime';
import {
  AutomationStore,
  automationEnabledKey,
  deleteAppSetting,
  makeGatewayDbProvider,
  readActiveCodeDir,
  syncAutomationsFromDisk,
  writeAppSetting,
  type AutomationRow,
  type RunnerStatus,
} from '@centraid/runtime-core';
import { clearProviderApiKey, hasProviderApiKey, setProviderApiKey } from './provider-secrets.js';

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

  // Provider secret (custom OpenAI-compatible endpoint API key, stored
  // via Electron `safeStorage` outside the gateway DB). The plaintext
  // never leaves the main process — the renderer only sees "has it / does not".
  PROVIDER_API_KEY_SET: 'centraid:agent:provider:setApiKey',
  PROVIDER_API_KEY_HAS: 'centraid:agent:provider:hasApiKey',
  PROVIDER_API_KEY_CLEAR: 'centraid:agent:provider:clearApiKey',

  // Force-refresh + return the current preflight status for the configured
  // runner (binary version + optional provider endpoint probe).
  RUNNER_STATUS_GET: 'centraid:agent:runner:status',

  // Automations (issue #70) — desktop UI surface. Reads the
  // per-gateway automations mirror table; manual run-now fires the
  // local `centraid run-automation` headless path in-process.
  AUTOMATIONS_LIST: 'centraid:automations:list',
  AUTOMATIONS_RUN_NOW: 'centraid:automations:run-now',
  AUTOMATIONS_SET_ENABLED: 'centraid:automations:set-enabled',
  AUTOMATIONS_DELETE: 'centraid:automations:delete',
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
  provider?: OpenAICompatProvider;
}> {
  const prefs = await fetchUserPrefs();
  const kindRaw = prefs['agent.runner.kind'];
  // Codex is the preferred default — mirrors the chat-side loader in
  // local-runtime.ts so the builder agent gets the same fallback when
  // the user hasn't explicitly picked a runner.
  const kind: 'codex' | 'claude-code' =
    kindRaw === 'codex' || kindRaw === 'claude-code' ? kindRaw : 'codex';
  const binPath =
    typeof prefs['agent.runner.binPath'] === 'string'
      ? (prefs['agent.runner.binPath'] as string)
      : undefined;
  const extraArgsRaw = prefs['agent.runner.extraArgs'];
  const extraArgs = Array.isArray(extraArgsRaw)
    ? (extraArgsRaw.filter((v) => typeof v === 'string') as string[])
    : undefined;
  const provider = await resolveProviderPrefs(prefs);
  return {
    kind,
    ...(binPath ? { binPath } : {}),
    ...(extraArgs ? { extraArgs } : {}),
    ...(provider ? { provider } : {}),
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
  ipcMain.handle(Channel.USER_PREFS_SAVE, async (_e, patch: Record<string, unknown>) => {
    const next = await saveUserPrefs(patch);
    // A change to any `agent.runner.*` key (kind, provider config) makes
    // the cached preflight stale. Invalidating unconditionally is cheap —
    // the next status read just re-probes once.
    if (Object.keys(patch).some((k) => k.startsWith('agent.runner.'))) {
      noteRunnerPrefsChanged();
    }
    return next;
  });

  // ----- Provider secret (custom OpenAI-compatible endpoint API key) -----
  // The plaintext lives only in the main process — renderer can set, query
  // presence, or clear, but never read the key back.
  ipcMain.handle(
    Channel.PROVIDER_API_KEY_SET,
    async (_e, input: { apiKey: string }): Promise<{ ok: true }> => {
      await setProviderApiKey(input.apiKey);
      noteRunnerPrefsChanged();
      return { ok: true };
    },
  );
  ipcMain.handle(
    Channel.PROVIDER_API_KEY_HAS,
    async (): Promise<{ present: boolean }> => ({ present: await hasProviderApiKey() }),
  );
  ipcMain.handle(Channel.PROVIDER_API_KEY_CLEAR, async (): Promise<{ ok: true }> => {
    await clearProviderApiKey();
    noteRunnerPrefsChanged();
    return { ok: true };
  });

  // ----- Runner / endpoint preflight -----
  // The settings UI calls this to show whether the codex binary is
  // installed AND whether the configured custom endpoint is reachable.
  // Always re-probes — the renderer only asks when the user opens the panel
  // or clicks "Test connection".
  ipcMain.handle(Channel.RUNNER_STATUS_GET, async (): Promise<RunnerStatus> => {
    noteRunnerPrefsChanged();
    const prefs = (await loadRunnerPrefs()) as RunnerPrefs;
    return runPreflight(prefs);
  });

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
        codexHomeBaseDir: localRuntimeCodexHomeBaseDir(),
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

      // Templates can ship automation manifests (`automations/*.json`).
      // The publish path syncs them into the per-gateway mirror via
      // `handleAppUpload`, but a fresh clone is a draft that hasn't been
      // uploaded yet — so without this call the cloned app's
      // Settings → Automations panel would appear empty until first
      // publish. Sync is idempotent and a no-op for templates that
      // ship no manifests.
      //
      // `dataDbFile` points at the eventual `data.sqlite` location
      // even though it doesn't exist yet at clone time — sync's read
      // returns undefined and every automation defaults to enabled,
      // which is the right initial state for freshly-cloned templates.
      await syncAutomationsFromDisk({
        appId: newAppId,
        appCodeDir: project.dir,
        store: getAutomationStore(),
        dataDbFile: path.join(localRuntimeAppsDir(), newAppId, 'data.sqlite'),
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

  // ----- Automations (issue #70) -----
  // The desktop reads the per-gateway automations mirror table directly.
  // The store is opened lazily; the local runtime owns the actual DB
  // handle so we wrap the same `localRuntimeGatewayDb()` path here.
  const getAutomationStore = (() => {
    let store: AutomationStore | undefined;
    return (): AutomationStore => {
      if (!store) {
        const provider = makeGatewayDbProvider(localRuntimeGatewayDb());
        store = new AutomationStore(provider);
      }
      return store;
    };
  })();

  ipcMain.handle(
    Channel.AUTOMATIONS_LIST,
    async (_e, input: { appId: string }): Promise<AutomationRow[]> => {
      return getAutomationStore().listByApp(input.appId);
    },
  );

  ipcMain.handle(
    Channel.AUTOMATIONS_RUN_NOW,
    async (
      _e,
      input: { appId: string; name: string },
    ): Promise<{
      ok: boolean;
      durationMs: number;
      error?: string;
      toolBatches: number;
      agentCalls: number;
    }> => {
      const appDir = path.join(localRuntimeAppsDir(), input.appId);
      // Code (manifest + handler) lives in the active version's subdir
      // after publish; data.sqlite + scratch live at the persistent app
      // root. The CLI's `run-automation` path does the same resolution
      // when fired by the OS scheduler.
      const codeDir = await readActiveCodeDir(appDir);
      const prefs = await loadRunnerPrefs();
      const { outcome, record } = await runAutomationLocal({
        appId: input.appId,
        appDir,
        codeDir,
        automationName: input.name,
        runner: prefs.kind,
      });
      return {
        ok: outcome.ok,
        durationMs: record.durationMs,
        ...(outcome.error ? { error: outcome.error } : {}),
        toolBatches: record.toolBatches,
        agentCalls: record.agentCalls,
      };
    },
  );

  ipcMain.handle(
    Channel.AUTOMATIONS_SET_ENABLED,
    async (_e, input: { appId: string; name: string; enabled: boolean }) => {
      // Source of truth: the app's data.sqlite __centraid_settings.
      // Mirror is a derived projection; we update it eagerly so the
      // UI list reflects the toggle without waiting for a sync. Host
      // gets register(row) — OsSchedulerHost collapses
      // enabled=false to unregister so launchd/systemd/Task
      // Scheduler don't keep a suppressed-but-installed entry.
      const dataDbFile = path.join(localRuntimeAppsDir(), input.appId, 'data.sqlite');
      writeAppSetting(dataDbFile, automationEnabledKey(input.name), input.enabled);
      const store = getAutomationStore();
      store.setEnabled(input.appId, input.name, input.enabled);
      const row = store.get(input.appId, input.name);
      if (row) {
        try {
          await localRuntimeAutomationHost().register(row);
        } catch (err) {
          console.warn(
            `[automations] host register failed for ${input.appId}/${input.name}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
      return { ok: true };
    },
  );

  ipcMain.handle(Channel.AUTOMATIONS_DELETE, async (_e, input: { appId: string; name: string }) => {
    // Delete is best-effort across four surfaces; we proceed past
    // individual failures because a stale entry on any one of them
    // is recoverable but a half-deleted state with no UI affordance
    // is worse.
    //
    //   1. OS scheduler: tear down the launchd/systemd/Task entry.
    //   2. Source project: remove the manifest from
    //      `<projectsDir>/<appId>/automations/<name>.json` so the
    //      next publish doesn't reintroduce it. The action handler
    //      at `actions/<name>.js` is intentionally left alone — it
    //      may be useful as a standalone script or referenced by a
    //      different automation; the builder agent can prune it
    //      explicitly if the user asks.
    //   3. Per-app settings: clear the toggle key so a future
    //      republish doesn't inherit a stale value if the user
    //      re-creates an automation under the same name.
    //   4. Mirror: drop the row so the UI hides it immediately.
    try {
      await localRuntimeAutomationHost().unregister(input.appId, input.name);
    } catch (err) {
      console.warn(
        `[automations] host unregister failed for ${input.appId}/${input.name}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    try {
      const settings = await loadSettings();
      const manifestPath = path.join(
        settings.projectsDir,
        input.appId,
        'automations',
        `${input.name}.json`,
      );
      await fs.rm(manifestPath, { force: true });
    } catch (err) {
      console.warn(
        `[automations] manifest rm failed for ${input.appId}/${input.name}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    deleteAppSetting(
      path.join(localRuntimeAppsDir(), input.appId, 'data.sqlite'),
      automationEnabledKey(input.name),
    );
    getAutomationStore().remove(input.appId, input.name);
    return { ok: true };
  });
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
