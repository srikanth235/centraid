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
  localRuntimeAutomationHost,
  localRuntimeCodexHomeBaseDir,
  localRuntimeAutomationDb,
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
  AutomationRunsStore,
  InsightsStore,
  listAutomationProjects,
  readAutomationProject,
  setAutomationEnabled,
  deleteAutomationProject,
  makeActivityDbProvider,
  generateWebhookId,
  generateWebhookSecret,
  hashWebhookSecret,
  provisionPendingWebhookAt,
  provisionAppPendingWebhooks,
  WEBHOOK_ROUTE_PREFIX,
  type ProvisionedWebhook,
  type AutomationRow,
  type AutomationRunNodeRow,
  type AutomationRunRow,
  type AutomationTrigger,
  type AutomationHistoryKeep,
  type DatabaseProvider,
  type InsightsSummary,
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

  // Automations (issue #91) — desktop UI surface over the on-disk
  // automation projects under `automationsDir`. Manual run-now fires
  // the local handler runtime in-process.
  AUTOMATIONS_LIST: 'centraid:automations:list',
  AUTOMATIONS_READ: 'centraid:automations:read',
  AUTOMATIONS_CREATE: 'centraid:automations:create',
  AUTOMATIONS_RUN_NOW: 'centraid:automations:run-now',
  AUTOMATIONS_SET_ENABLED: 'centraid:automations:set-enabled',
  AUTOMATIONS_DELETE: 'centraid:automations:delete',
  // Run audit + node timeline (issue #80 / #90). Read-only views over
  // the unified `runs` / `run_nodes` ledger.
  AUTOMATIONS_LIST_RUNS: 'centraid:automations:list-runs',
  AUTOMATIONS_LIST_RUN_NODES: 'centraid:automations:list-run-nodes',
  // Pin / unpin a run as a replay fixture (issue #80 follow-up).
  AUTOMATIONS_PIN_RUN: 'centraid:automations:pin-run',

  // Insights (issue #90) — read-only analytics over the unified run
  // ledger. One channel returns the whole screen's payload.
  INSIGHTS_SUMMARY: 'centraid:insights:summary',
} as const;

/**
 * A webhook the post-turn provisioning pass minted for an automation
 * the builder agent authored. The plaintext `secret` crosses to the
 * renderer exactly once — it is shown to the user and never persisted
 * (the manifest keeps only the SHA-256 hash).
 */
interface MintedWebhookInfo {
  automationId: string;
  ownerApp?: string;
  webhookId: string;
  url: string;
  secret: string;
}

interface AgentSessionHandle {
  projectId: string;
  projectDir: string;
  prompt(text: string): Promise<{ mintedWebhooks: MintedWebhookInfo[] }>;
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
    return listProjects(settings.appsDir);
  });

  ipcMain.handle(
    Channel.PROJECTS_CREATE,
    async (_e, input: { id: string; name?: string; version?: string }) => {
      const settings = await loadSettings();
      const { scaffoldProject } = await import('@centraid/builder-harness');
      return scaffoldProject(settings.appsDir, input.id, {
        name: input.name,
        version: input.version,
      });
    },
  );

  ipcMain.handle(Channel.PROJECTS_FILES, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { readProjectFiles } = await import('@centraid/builder-harness');
    const dir = path.join(settings.appsDir, input.id);
    return readProjectFiles(dir);
  });

  ipcMain.handle(
    Channel.PROJECTS_WRITE_FILE,
    async (_e, input: { id: string; path: string; content: string }) => {
      const settings = await loadSettings();
      const { writeProjectFile } = await import('@centraid/builder-harness');
      const dir = path.join(settings.appsDir, input.id);
      return writeProjectFile(dir, input.path, input.content);
    },
  );

  ipcMain.handle(Channel.PROJECTS_OPEN, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const dir = path.join(settings.appsDir, input.id);
    await shell.openPath(dir);
    return { ok: true };
  });

  ipcMain.handle(Channel.PROJECTS_DELETE, async (_e, input: { id: string }) => {
    const settings = await loadSettings();
    const { deleteProject } = await import('@centraid/builder-harness');
    await deleteProject(settings.appsDir, input.id);
    return { ok: true };
  });

  ipcMain.handle(
    Channel.PROJECTS_UPDATE_META,
    async (_e, input: { id: string; name?: string; description?: string }) => {
      const settings = await loadSettings();
      const { updateProjectMeta } = await import('@centraid/builder-harness');
      await updateProjectMeta(settings.appsDir, input.id, {
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
      const indexPath = path.join(settings.appsDir, input.id, 'index.html');
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
      input: {
        projectId: string;
        projectKind?: 'app' | 'automation';
        sessionMode?: 'fresh' | 'continue' | 'in-memory';
      },
    ): Promise<{ ok: true; messages: unknown[] }> => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) throw new Error('no window for agent session');

      const prior = sessions.get(win.id);
      if (prior) await prior.stop().catch(() => {});

      const settings = await loadSettings();
      const { createCentraidAgentSession } = await import('@centraid/builder-harness');
      // Automations are first-class projects under `automationsDir`; apps
      // live under `appsDir`. The kind also picks the system prompt and
      // gates the app-only live-schema injection / preview snapshot.
      const isAutomation = input.projectKind === 'automation';
      const projectDir = path.join(
        isAutomation ? settings.automationsDir : settings.appsDir,
        input.projectId,
      );

      const runnerPrefs = await loadRunnerPrefs();

      const session = await createCentraidAgentSession({
        projectDir,
        runnerPrefs,
        sessionMode: input.sessionMode,
        codexHomeBaseDir: localRuntimeCodexHomeBaseDir(),
        ...(isAutomation
          ? { projectKind: 'automation' as const }
          : { liveSchema: { config: settings, appId: input.projectId } }),
      });

      const unsubscribe = session.subscribe((evt) => {
        if (win.isDestroyed()) return;
        win.webContents.send(Channel.AGENT_EVENT, {
          projectId: input.projectId,
          event: evt,
        });
      });

      // Mint id + secret for any pending webhook trigger the agent
      // declared this turn (`{ kind: 'webhook', pending: true }`). The
      // agent cannot generate crypto-random credentials; the builder
      // can. Rewrites the manifest in place and returns the one-time
      // secrets for the renderer to show. Best-effort — a provisioning
      // failure must not fail the turn.
      const provisionPendingWebhooks = async (): Promise<MintedWebhookInfo[]> => {
        const gatewayBase = settings.remoteGatewayUrl.replace(/\/+$/, '');
        const toInfo = (w: ProvisionedWebhook): MintedWebhookInfo => ({
          automationId: w.automationId,
          ...(w.ownerApp ? { ownerApp: w.ownerApp } : {}),
          webhookId: w.webhookId,
          url: `${gatewayBase}${WEBHOOK_ROUTE_PREFIX}/${w.webhookId}`,
          secret: w.secret,
        });
        try {
          if (isAutomation) {
            const minted = await provisionPendingWebhookAt(projectDir);
            return minted ? [toInfo(minted)] : [];
          }
          return (await provisionAppPendingWebhooks(projectDir)).map(toInfo);
        } catch (err) {
          console.warn(
            `[automations] webhook provisioning failed for ${input.projectId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
          return [];
        }
      };

      sessions.set(win.id, {
        projectId: input.projectId,
        projectDir,
        prompt: async (text: string) => {
          // Refresh the preview snapshot the agent reads via its native
          // `Read` tool / `centraid preview snapshot`. Best-effort —
          // capture errors (preview tab not visible, no index.html yet)
          // shouldn't block the turn; the snapshot subcommand will just
          // report `exists: false` and the agent can adapt. Automations
          // have no preview iframe, so there is nothing to snapshot.
          if (!isAutomation) {
            await capturePreviewSnapshot(win, projectDir).catch(() => undefined);
          }
          await session.prompt(text);
          return { mintedWebhooks: await provisionPendingWebhooks() };
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
    const { mintedWebhooks } = await handle.prompt(input.text);
    return { ok: true, mintedWebhooks };
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
    const projectDir = path.join(settings.appsDir, input.id);
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
      const newAppId = await suggestAppId(settings.appsDir, input.newAppId ?? tmpl.id, {
        alwaysSuffix: !input.newAppId,
      });

      const project = await cloneTemplate({
        projectsDir: settings.appsDir,
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

  // ----- Automations (issue #91) -----
  // Automation *definitions* are projects on disk under `automationsDir`
  // (read via runtime-core's `automation-project` helpers). The unified
  // run ledger lives in the activity DB — one lazily-opened provider
  // over `localRuntimeAutomationDb()` is shared by every store here.
  const getActivityDbProvider = (() => {
    let provider: DatabaseProvider | undefined;
    return (): DatabaseProvider => {
      if (!provider) provider = makeActivityDbProvider(localRuntimeAutomationDb());
      return provider;
    };
  })();

  ipcMain.handle(Channel.AUTOMATIONS_LIST, async (): Promise<AutomationRow[]> => {
    const settings = await loadSettings();
    const { rows } = await listAutomationProjects(settings.automationsDir);
    return rows;
  });

  ipcMain.handle(
    Channel.AUTOMATIONS_READ,
    async (_e, input: { automationId: string }): Promise<AutomationRow | null> => {
      const settings = await loadSettings();
      const row = await readAutomationProject(settings.automationsDir, input.automationId).catch(
        () => undefined,
      );
      return row ?? null;
    },
  );

  ipcMain.handle(
    Channel.AUTOMATIONS_CREATE,
    async (
      _e,
      input: {
        id: string;
        name?: string;
        description?: string;
        prompt?: string;
        /**
         * Trigger list. A `webhook` entry carries no secret — the
         * handler mints id + secret server-side. Omit the field to take
         * the scaffold default (a daily cron); pass `[]` for a
         * manual-only automation.
         */
        triggers?: Array<{ kind: 'cron'; expr: string } | { kind: 'webhook' }>;
        apps?: string[];
        model?: string;
        historyKeep?: AutomationHistoryKeep;
        onFailure?: string;
        /**
         * Initial enabled flag. The conversational builder passes
         * `false` to scaffold a draft the user enables after review.
         */
        enabled?: boolean;
      },
    ): Promise<{
      row: AutomationRow;
      /** Present when a webhook trigger was created — shown to the user once. */
      webhook?: { id: string; secret: string; url: string };
    }> => {
      const settings = await loadSettings();
      const { scaffoldAutomationProject } = await import('@centraid/builder-harness');

      // Mint webhook secrets server-side: the plaintext is returned once
      // here, the manifest persists only its hash.
      let webhook: { id: string; secret: string; url: string } | undefined;
      const triggers: AutomationTrigger[] | undefined = input.triggers?.map((t) => {
        if (t.kind === 'webhook') {
          const id = generateWebhookId();
          const secret = generateWebhookSecret();
          webhook = {
            id,
            secret,
            url: `${settings.remoteGatewayUrl.replace(/\/+$/, '')}/_centraid-hook/${id}`,
          };
          return { kind: 'webhook', id, secretHash: hashWebhookSecret(secret) };
        }
        return { kind: 'cron', expr: t.expr };
      });

      await scaffoldAutomationProject(settings.automationsDir, input.id, {
        ...(input.name ? { name: input.name } : {}),
        ...(input.description ? { description: input.description } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
        ...(triggers !== undefined ? { triggers } : {}),
        ...(input.apps ? { apps: input.apps } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(input.historyKeep ? { historyKeep: input.historyKeep } : {}),
        ...(input.onFailure ? { onFailure: input.onFailure } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      });
      const row = await readAutomationProject(settings.automationsDir, input.id);
      if (!row) throw new Error(`automation ${input.id}: scaffolded but not found on disk`);
      try {
        await localRuntimeAutomationHost(settings.automationsDir).register(row);
      } catch (err) {
        console.warn(
          `[automations] host register failed for ${input.id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      return { row, ...(webhook ? { webhook } : {}) };
    },
  );

  ipcMain.handle(
    Channel.AUTOMATIONS_RUN_NOW,
    async (
      _e,
      input: { automationId: string },
    ): Promise<{
      ok: boolean;
      durationMs: number;
      error?: string;
      toolBatches: number;
      agentCalls: number;
    }> => {
      const settings = await loadSettings();
      const prefs = await loadRunnerPrefs();
      const { outcome, record } = await runAutomationLocal({
        automationId: input.automationId,
        automationsDir: settings.automationsDir,
        activityDb: getActivityDbProvider(),
        runner: prefs.kind,
        // "Run now" is a manual fire — tag it so the executions log
        // distinguishes it from the OS-scheduler trigger.
        triggerKind: 'manual',
        triggerOrigin: 'manual',
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
    async (_e, input: { automationId: string; enabled: boolean }) => {
      // `manifest.enabled` is the source of truth — toggling rewrites
      // `automation.json`. Host gets register(row); OsSchedulerHost
      // collapses enabled=false to unregister.
      const settings = await loadSettings();
      const row = await setAutomationEnabled(
        settings.automationsDir,
        input.automationId,
        input.enabled,
      );
      if (row) {
        try {
          await localRuntimeAutomationHost(settings.automationsDir).register(row);
        } catch (err) {
          console.warn(
            `[automations] host register failed for ${input.automationId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
      return { ok: true };
    },
  );

  ipcMain.handle(Channel.AUTOMATIONS_DELETE, async (_e, input: { automationId: string }) => {
    // Delete is best-effort: tear down the OS scheduler entry, then
    // drop the project dir + its run ledger.
    const settings = await loadSettings();
    try {
      await localRuntimeAutomationHost(settings.automationsDir).unregister(input.automationId);
    } catch (err) {
      console.warn(
        `[automations] host unregister failed for ${input.automationId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    await deleteAutomationProject(settings.automationsDir, input.automationId);
    new AutomationRunsStore(getActivityDbProvider()).deleteAutomationData(input.automationId);
    return { ok: true };
  });

  // Run ledger reads. `automationId` is optional — omit it for the
  // global Executions feed. An automation that never fired has no rows.
  ipcMain.handle(
    Channel.AUTOMATIONS_LIST_RUNS,
    async (_e, input: { automationId?: string; limit?: number }): Promise<AutomationRunRow[]> => {
      const store = new AutomationRunsStore(getActivityDbProvider());
      const limit = input.limit ?? 50;
      const runs = store.listRuns({
        ...(input.automationId ? { automationId: input.automationId } : {}),
        limit,
      });
      // The global feed mixes chat / build runs in — the Automations
      // screen only wants automation fires.
      return runs.filter((r) => r.kind === 'automation');
    },
  );

  ipcMain.handle(
    Channel.AUTOMATIONS_LIST_RUN_NODES,
    async (_e, input: { runId: string }): Promise<AutomationRunNodeRow[]> => {
      const store = new AutomationRunsStore(getActivityDbProvider());
      return store.listNodes(input.runId);
    },
  );

  // Pin / unpin a run as a replay fixture.
  ipcMain.handle(
    Channel.AUTOMATIONS_PIN_RUN,
    async (_e, input: { runId: string; pinned: boolean }): Promise<{ ok: true }> => {
      const store = new AutomationRunsStore(getActivityDbProvider());
      store.setPinned(input.runId, input.pinned);
      return { ok: true };
    },
  );

  // Insights — the whole screen's analytics payload in one read over the
  // unified run ledger (chat turns + automation fires + builder runs).
  ipcMain.handle(
    Channel.INSIGHTS_SUMMARY,
    async (_e, input?: { windowDays?: number }): Promise<InsightsSummary> => {
      const store = new InsightsStore(getActivityDbProvider());
      return store.summary(input?.windowDays !== undefined ? { windowDays: input.windowDays } : {});
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
