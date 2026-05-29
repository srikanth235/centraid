// governance: allow-repo-hygiene file-size-limit ipc-hub pending split per-feature handler modules (agent, chat, projects, provider) once the surface stabilizes
import { ipcMain, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  loadSettings,
  saveSettings,
  setActiveGatewayId,
  templatesCacheDir,
  type DesktopSettings,
} from './settings.js';
import {
  addGateway,
  addLocalGateway,
  GatewayError,
  listGateways,
  removeGateway,
  renameGateway,
  updateGatewayToken,
  updateProfileMetadata,
  type GatewayProfile,
} from './gateway-store.js';
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
  deleteApp as appsStoreDeleteApp,
  listAppsWithMeta as appsStoreListAppsWithMeta,
  publishApp as appsStorePublishApp,
  readDraftFiles as appsStoreReadDraftFiles,
  resetAppsStoreAuthCache,
  rollbackApp as appsStoreRollbackApp,
  listGitVersions as appsStoreListGitVersions,
  writeDraftFile as appsStoreWriteDraftFile,
} from './apps-store-client.js';
import {
  dropProjectSession,
  ensureProjectSession,
  ensureProjectSessionAppsParent,
  ensureProjectSessionDir,
  resetProjectSessions,
} from './project-sessions.js';
import {
  importAvailableCreds,
  readAuthStatus,
  type AuthImportResult,
  type AuthStatus,
} from './auth-import.js';
import {
  localRuntimeActiveCodeAppsDir,
  localRuntimeAutomationHost,
  localRuntimeCodexHomeBaseDir,
  localRuntimeAppsDir,
  localRuntimeAnalyticsDb,
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
  AnalyticsStore,
  APP_AUTOMATIONS_SUBDIR,
  AutomationRunsStore,
  InsightsStore,
  listAutomations,
  readAppOwnedAutomation,
  readAutomationProjectAt,
  setAutomationEnabledAt,
  deleteAutomationAt,
  parseAutomationRef,
  makeAnalyticsDbProvider,
  makeRuntimeDbProvider,
  generateWebhookId,
  generateWebhookSecret,
  hashWebhookSecret,
  provisionAppPendingWebhooks,
  WEBHOOK_ROUTE_PREFIX,
  type ProvisionedWebhook,
  type AutomationRow,
  type AutomationRunNodeRow,
  type AutomationRunRow,
  type AutomationTrigger,
  type AutomationTriggerKind,
  type AutomationTriggerOrigin,
  type AutomationHistoryKeep,
  type DatabaseProvider,
  type InsightsSummary,
  type RunSummary,
  type RunnerStatus,
} from '@centraid/runtime-core';
import { clearProviderApiKey, hasProviderApiKey, setProviderApiKey } from './provider-secrets.js';
import { disposeWindowChatSessions } from './chat.js';

/**
 * Status read for the auto-publish queue (issue #137: there is no
 * queue anymore — every publish is synchronous via PUBLISH IPC). Kept
 * as a stable renderer surface so `builder.ts` doesn't need to change;
 * always returns "not in flight". The `PUBLISH_EVENT` channel is
 * similarly never fired post-#137 — the renderer's onPublishEvent
 * subscription just stays quiet.
 */
type PublishStatus = { inFlight: boolean; lastError?: string; lastPublishedAt?: number };
const getPublishStatus = (_id: string): PublishStatus => ({ inFlight: false });

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

  /** Status read for the auto-publish queue (renderer toast / debug). */
  PUBLISH_STATUS: 'centraid:publish:status',

  // Gateway lifecycle (issue #109). The primordial local gateway
  // ('local') is special-cased (always present, can't be removed).
  // Remote gateways and additional local gateways (workspaces) get
  // UUID ids and can be renamed/removed freely.
  GATEWAYS_LIST: 'centraid:gateways:list',
  GATEWAYS_ADD: 'centraid:gateways:add',
  GATEWAYS_ADD_LOCAL: 'centraid:gateways:add-local',
  GATEWAYS_REMOVE: 'centraid:gateways:remove',
  GATEWAYS_RENAME: 'centraid:gateways:rename',
  GATEWAYS_UPDATE_METADATA: 'centraid:gateways:update-metadata',
  GATEWAYS_UPDATE_TOKEN: 'centraid:gateways:update-token',
  GATEWAYS_SET_ACTIVE: 'centraid:gateways:set-active',
  GATEWAY_CHANGED: 'centraid:gateways:changed',

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

  // Automations (issue #98) — desktop UI surface over the automations
  // owned by app folders under `appsDir`. Manual run-now fires the
  // local handler runtime in-process.
  AUTOMATIONS_LIST: 'centraid:automations:list',
  AUTOMATIONS_READ: 'centraid:automations:read',
  AUTOMATIONS_CREATE: 'centraid:automations:create',
  AUTOMATIONS_RUN_NOW: 'centraid:automations:run-now',
  AUTOMATIONS_SET_ENABLED: 'centraid:automations:set-enabled',
  AUTOMATIONS_DELETE: 'centraid:automations:delete',
  // Run audit + node timeline (issue #80 / #90). Read-only views over
  // the unified `runs` / `run_nodes` ledger.
  AUTOMATIONS_LIST_RUNS: 'centraid:automations:list-runs',
  AUTOMATIONS_READ_RUN: 'centraid:automations:read-run',
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
  ownerApp: string;
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
  // `fetchUserPrefs` routes to the active gateway's `/_centraid-user/prefs`,
  // so we need to scope the provider API key to that same active gateway —
  // otherwise we'd mix one gateway's config with another's key.
  const settings = await loadSettings();
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
  const provider = await resolveProviderPrefs(prefs, settings.activeGatewayId);
  return {
    kind,
    ...(binPath ? { binPath } : {}),
    ...(extraArgs ? { extraArgs } : {}),
    ...(provider ? { provider } : {}),
  };
}

export function registerIpcHandlers(): void {
  // Broadcast helper for "active gateway changed" — fires after any
  // mutation that affects the active gateway's URL/token/identity so
  // the renderer can drop and re-fetch gateway-scoped state.
  const broadcastGatewayChanged = (next: DesktopSettings): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(Channel.GATEWAY_CHANGED, {
        activeGatewayId: next.activeGatewayId,
        activeGatewayKind: next.activeGatewayKind,
        activeGatewayLabel: next.activeGatewayLabel,
        activeProfileDisplayName: next.activeProfileDisplayName,
        activeProfileAvatarColor: next.activeProfileAvatarColor,
      });
    }
  };

  // Invalidate the renderer's HTTP-client caches after a gateway swap
  // or token rotation. The auth-injector caches an Authorization
  // header per origin; the user-prefs / chat-history clients cache
  // their bearer too. All three need to drop their caches together.
  const invalidateGatewayCaches = async (): Promise<void> => {
    resetChatHistoryAuthCache();
    resetUserPrefsAuthCache();
    resetAppsStoreAuthCache();
    // Per-app editing sessions are per-gateway (the worktrees live in
    // the previous gateway's git store); forget them so the next edit
    // opens a fresh session on the new active gateway.
    resetProjectSessions();
    await refreshAuthInjector();
  };

  // Stop every live agent + chat session across every window when the
  // active gateway changes. Those sessions were rooted in the previous
  // gateway's workspace + identity DB; letting them keep running would
  // mean the agent writing into gateway A's workspace + auto-publishing
  // to gateway A's appsDir while the user thinks they're on gateway B.
  // Disposing here is unconditional — the renderer's onGatewayChanged
  // handler also bounces back to Home, so there's no live UI tied to
  // these sessions at the moment they end.
  const disposeAllSessionsForGatewaySwap = async (): Promise<void> => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      await disposeWindowSession(win.id);
      disposeWindowChatSessions(win.id);
    }
  };

  // ----- Settings -----
  ipcMain.handle(Channel.SETTINGS_GET, async () => loadSettings());
  ipcMain.handle(Channel.SETTINGS_SAVE, async (_e, patch: Partial<DesktopSettings>) => {
    const next = await saveSettings(patch);
    // Settings can no longer flip gateway URL/token directly (those
    // live in the gateway store), but the active gateway pointer can
    // change through here — invalidate caches the same way.
    await invalidateGatewayCaches();
    return next;
  });

  // ----- Gateways (issue #109) -----
  // The local gateway is always present and can't be removed; remote
  // gateways are added/removed/renamed through the Settings → Gateways
  // panel. Tokens never cross the bridge — `add` accepts plaintext
  // and immediately persists to keychain via gateway-secrets.
  ipcMain.handle(Channel.GATEWAYS_LIST, async (): Promise<GatewayProfile[]> => listGateways());

  ipcMain.handle(
    Channel.GATEWAYS_ADD,
    async (
      _e,
      input: {
        label: string;
        url: string;
        token: string;
        displayName?: string;
        avatarColor?: string;
      },
    ): Promise<GatewayProfile> => addGateway(input),
  );

  ipcMain.handle(
    Channel.GATEWAYS_ADD_LOCAL,
    async (
      _e,
      input: { label: string; displayName?: string; avatarColor?: string },
    ): Promise<GatewayProfile> => addLocalGateway(input),
  );

  ipcMain.handle(
    Channel.GATEWAYS_UPDATE_METADATA,
    async (
      _e,
      input: { id: string; displayName?: string; avatarColor?: string },
    ): Promise<GatewayProfile> => {
      const updated = await updateProfileMetadata(input.id, {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.avatarColor !== undefined ? { avatarColor: input.avatarColor } : {}),
      });
      // Metadata-only change — no URL/token flip — but the renderer's
      // switcher cache wants to refresh, so emit on the bus.
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      return updated;
    },
  );

  ipcMain.handle(
    Channel.GATEWAYS_REMOVE,
    async (_e, input: { id: string }): Promise<{ activeGatewayId: string }> => {
      try {
        await removeGateway(input.id);
      } catch (err) {
        if (err instanceof GatewayError && err.code === 'local_not_removable') {
          throw new Error(err.message, { cause: err });
        }
        throw err;
      }
      // If the active gateway was removed, fall back to local. Either
      // way the caches need to drop so the renderer's HTTP clients
      // re-resolve via the (possibly new) active gateway. Sessions
      // are disposed too — they may have been rooted in the removed
      // gateway's workspace, and even when they weren't, the renderer
      // will bounce home on the broadcast so any UI tying back to them
      // is gone anyway.
      const current = await loadSettings();
      let next: DesktopSettings = current;
      if (current.activeGatewayId === input.id) {
        await disposeAllSessionsForGatewaySwap();
        next = await setActiveGatewayId('local');
      }
      await invalidateGatewayCaches();
      broadcastGatewayChanged(next);
      return { activeGatewayId: next.activeGatewayId };
    },
  );

  ipcMain.handle(
    Channel.GATEWAYS_RENAME,
    async (_e, input: { id: string; label: string }): Promise<GatewayProfile> => {
      const updated = await renameGateway(input.id, input.label);
      // Label-only change — no token/URL flip — but the renderer's
      // switcher label cache wants to refresh, so emit on the bus.
      const next = await loadSettings();
      broadcastGatewayChanged(next);
      return updated;
    },
  );

  // Rotate the keychain-stored bearer token for a remote gateway.
  // Plaintext crosses the bridge exactly once on this call (same shape
  // as `add`) and is immediately persisted via gateway-secrets. Pass
  // an empty string to clear. No-op for the local gateway (its token
  // is minted per launch by the in-process runtime). When the rotated
  // profile is the active one, drop HTTP-client auth caches so the
  // next request re-reads the new token from the keychain.
  ipcMain.handle(
    Channel.GATEWAYS_UPDATE_TOKEN,
    async (_e, input: { id: string; token: string }): Promise<{ ok: true }> => {
      await updateGatewayToken(input.id, input.token);
      const current = await loadSettings();
      if (current.activeGatewayId === input.id) {
        await invalidateGatewayCaches();
        broadcastGatewayChanged(current);
      }
      return { ok: true };
    },
  );

  ipcMain.handle(
    Channel.GATEWAYS_SET_ACTIVE,
    async (_e, input: { id: string }): Promise<DesktopSettings> => {
      // Stop sessions BEFORE flipping the pointer — otherwise an
      // in-flight `prompt` could land its writes after the swap with
      // the old session handle still mapping to old paths.
      await disposeAllSessionsForGatewaySwap();
      const next = await setActiveGatewayId(input.id);
      // Tear down HTTP servers for any local gateways that aren't the
      // new active one. OS-scheduled automations are unaffected — they
      // shell the CLI against per-gateway DB paths and don't depend on
      // the runtime being up. For multi-local installs this keeps just
      // one in-process server alive at a time; for the common
      // local-then-remote case it shuts the local server down entirely.
      const { shutdownAllLocalRuntimesExcept } = await import('./local-runtime.js');
      await shutdownAllLocalRuntimesExcept(
        next.activeGatewayKind === 'local' ? next.activeGatewayId : undefined,
      );
      await invalidateGatewayCaches();
      broadcastGatewayChanged(next);
      return next;
    },
  );

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
  // presence, or clear, but never read the key back. Per-gateway (#109)
  // because the matching provider config (URL, envKey, ...) is already
  // per-gateway in the identity DB; storing the key against the same
  // active gateway keeps config + key matched. Switching gateways
  // surfaces a different (possibly empty) slot to the AI providers panel.
  ipcMain.handle(
    Channel.PROVIDER_API_KEY_SET,
    async (_e, input: { apiKey: string }): Promise<{ ok: true }> => {
      const settings = await loadSettings();
      await setProviderApiKey(settings.activeGatewayId, input.apiKey);
      noteRunnerPrefsChanged();
      return { ok: true };
    },
  );
  ipcMain.handle(Channel.PROVIDER_API_KEY_HAS, async (): Promise<{ present: boolean }> => {
    const settings = await loadSettings();
    return { present: await hasProviderApiKey(settings.activeGatewayId) };
  });
  ipcMain.handle(Channel.PROVIDER_API_KEY_CLEAR, async (): Promise<{ ok: true }> => {
    const settings = await loadSettings();
    await clearProviderApiKey(settings.activeGatewayId);
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

  // ----- Projects (issue #137: git-store backend) -----
  // All project lifecycle (list/create/files/write/delete/update-meta)
  // flows through the gateway's git store. No more `workspaceDir`:
  // code lives in `apps.git` + materialized-main + per-session
  // worktrees. Each handler:
  //   - opens (or reuses) a session for the app id,
  //   - mutates the session worktree directly (filesystem ops on the
  //     materialized session dir — local for the local gateway),
  //   - publishes the session — explicit, no debounce.
  ipcMain.handle(Channel.PROJECTS_LIST, async () => {
    return appsStoreListAppsWithMeta();
  });

  ipcMain.handle(
    Channel.PROJECTS_CREATE,
    async (_e, input: { id: string; name?: string; version?: string }) => {
      const { scaffoldProject } = await import('@centraid/builder-harness');
      const parent = await ensureProjectSessionAppsParent(input.id);
      const info = await scaffoldProject(parent, input.id, {
        name: input.name,
        version: input.version,
      });
      // Initial publish so the fresh app is browsable in the iframe
      // without waiting for a first edit.
      const sessionId = await ensureProjectSession(input.id);
      await appsStorePublishApp(sessionId, input.id, `scaffold ${input.id}`).catch(() => undefined);
      return info;
    },
  );

  ipcMain.handle(Channel.PROJECTS_FILES, async (_e, input: { id: string }) => {
    const sessionId = await ensureProjectSession(input.id);
    return appsStoreReadDraftFiles(sessionId, input.id);
  });

  ipcMain.handle(
    Channel.PROJECTS_WRITE_FILE,
    async (_e, input: { id: string; path: string; content: string }) => {
      // Explicit-publish model: writes land in the session worktree
      // only; nothing reaches `main` until the user clicks Publish.
      const sessionId = await ensureProjectSession(input.id);
      return appsStoreWriteDraftFile(sessionId, input.id, input.path, input.content);
    },
  );

  ipcMain.handle(Channel.PROJECTS_OPEN, async (_e, input: { id: string }) => {
    // Opens the session worktree on disk — the dir the agent + editor
    // write through. Local-gateway only (the helper errors for remote).
    const dir = await ensureProjectSessionDir(input.id);
    await shell.openPath(dir);
    return { ok: true };
  });

  ipcMain.handle(Channel.PROJECTS_DELETE, async (_e, input: { id: string }) => {
    // Drop the editing session first so its worktree doesn't fight
    // with the main-side delete, then HTTP-delete the app entirely
    // (forward commit + tag cleanup; registry deregister wired
    // gateway-side via onAppDeleted).
    await dropProjectSession(input.id);
    await appsStoreDeleteApp(input.id).catch(() => undefined);
    return { ok: true };
  });

  ipcMain.handle(
    Channel.PROJECTS_UPDATE_META,
    async (_e, input: { id: string; name?: string; description?: string }) => {
      const { updateProjectMeta } = await import('@centraid/builder-harness');
      const parent = await ensureProjectSessionAppsParent(input.id);
      await updateProjectMeta(parent, input.id, {
        name: input.name,
        description: input.description,
      });
      // Meta edits ride the explicit-publish model too — the renderer
      // triggers a Publish if it wants the change live.
      return { ok: true };
    },
  );

  // Preview URL for the iframe. The preview always serves the active
  // gateway version (issue #137: published on `main`), so the URL is
  // only "available" once an initial publish has landed at least one
  // version tag — the preview protocol returns 404 until then.
  ipcMain.handle(
    Channel.PROJECTS_PREVIEW_URL,
    async (_e, input: { id: string }): Promise<{ url: string; available: boolean }> => {
      const available = await appsStoreListGitVersions(input.id)
        .then((list) => list.length > 0)
        .catch(() => false);
      // Cache-bust per request — the iframe URL is stable but the
      // active version under the hood changes after each publish.
      const url = `${PREVIEW_SCHEME}://${encodeURIComponent(input.id)}/index.html?t=${Date.now()}`;
      return { url, available };
    },
  );

  // Snapshot of the auto-publish queue for project `id`. Cheap; safe to
  // poll from the renderer if a toast wants the latest error string.
  ipcMain.handle(
    Channel.PUBLISH_STATUS,
    async (_e, input: { id: string }): Promise<PublishStatus> => getPublishStatus(input.id),
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
      // Issue #137: the agent writes directly into the git store's
      // session worktree — its native Read/Write tools touch the same
      // dir the gateway's apps-store-routes read from, and the
      // synchronous post-turn `publishApp` drives the edits onto main.
      // `projectKind` still picks the system prompt + gates the app-
      // only live-schema injection / preview snapshot.
      const isAutomation = input.projectKind === 'automation';
      const projectDir = await ensureProjectSessionDir(input.projectId);

      const runnerPrefs = await loadRunnerPrefs();

      const session = await createCentraidAgentSession({
        projectDir,
        runnerPrefs,
        sessionMode: input.sessionMode,
        codexHomeBaseDir: localRuntimeCodexHomeBaseDir(settings.activeGatewayId),
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
        // Webhook URLs always point at the active gateway — local or
        // remote — so the agent's manifest references match wherever
        // the user actually publishes.
        const gatewayBase = settings.gatewayUrl.replace(/\/+$/, '');
        const toInfo = (w: ProvisionedWebhook): MintedWebhookInfo => ({
          automationId: w.automationId,
          ownerApp: w.ownerApp,
          webhookId: w.webhookId,
          url: `${gatewayBase}${WEBHOOK_ROUTE_PREFIX}/${w.webhookId}`,
          secret: w.secret,
        });
        try {
          // Both UI apps and automation apps are app folders that may own
          // automations under `automations/` — scan the whole folder.
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
          // Agent's writes landed in the session worktree directly.
          // Publish synchronously so the iframe + OS scheduler see the
          // new version once the turn settles. Best-effort: publish
          // failures (no_changes for a chat-only turn, gateway down)
          // shouldn't fail the prompt.
          const sid = await ensureProjectSession(input.projectId);
          await appsStorePublishApp(sid, input.projectId, `agent turn`).catch(() => undefined);
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

  // ----- Publish + versions (issue #137: git-store backend) -----
  // Publish is the ONLY way edits reach `main` now. The renderer's
  // explicit Publish button drives this; there is no auto-publish-on-
  // save for the Code tab. `skipBuild` is accepted for back-compat but
  // ignored — the git store doesn't bundle.
  ipcMain.handle(Channel.PUBLISH, async (_e, input: { id: string; skipBuild?: boolean }) => {
    void input.skipBuild;
    const sessionId = await ensureProjectSession(input.id);
    const result = await appsStorePublishApp(sessionId, input.id, `publish ${input.id}`);
    // Adapt to the renderer's existing CentraidPublishResult shape so
    // builder.ts doesn't need to change. bytes/files retire — the git
    // backend doesn't ship per-version aggregates. activated is always
    // true (publish == merge into main).
    return {
      id: result.id,
      versionId: result.versionTag,
      sha256: result.sha,
      activated: true,
      files: 0,
      bytes: 0,
      migrationsApplied: [] as number[],
    };
  });

  ipcMain.handle(Channel.VERSIONS_LIST, async (_e, input: { id: string }) => {
    const list = await appsStoreListGitVersions(input.id).catch(() => []);
    if (list.length === 0) return { versions: [] };
    // The git store marks the active tag explicitly (`active: true` on
    // the entry whose `apps/<appId>/` subtree matches main). After a
    // forward publish, that's the newest tag; after a rollback overlay,
    // it's the older tag whose subtree was re-laid — NOT necessarily
    // list[0]. The renderer reads `activeVersion` to set the live URL
    // on app reopen, so the shape mirrors the legacy `listVersions`.
    const activeEntry = list.find((v) => v.active);
    const versions = list.map((v) => ({
      versionId: v.tag,
      sha256: v.sha,
      declaredVersion: String(v.version),
      uploadedAt: v.uploadedAt,
      bytes: 0,
      files: 0,
      ...(v.active ? { current: true } : {}),
    }));
    return {
      versions,
      ...(activeEntry ? { activeVersion: activeEntry.tag } : {}),
    };
  });

  ipcMain.handle(
    Channel.VERSIONS_ACTIVATE,
    async (_e, input: { id: string; versionId: string }) => {
      // `versionId` from the renderer is the version tag (e.g.
      // `<appId>/v3`) — same shape we returned from VERSIONS_LIST.
      // Rollback overlays that tag's subtree on main as a fresh commit;
      // we report the requested tag back as the active version.
      await appsStoreRollbackApp(input.id, input.versionId);
      return { activeVersion: input.versionId };
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
    const settings = await loadSettings();
    const { resolveTemplates } = await import('@centraid/app-templates');
    // Strip `files` + `source` from the wire response — the renderer only
    // needs the display metadata, and the lists can be sizable. Cache
    // is per-gateway (#109) so we resolve against the active one.
    const resolved = await resolveTemplates({
      cacheDir: templatesCacheDir(settings.activeGatewayId),
    });
    return resolved.map((t) => ({
      id: t.id,
      name: t.name,
      desc: t.desc,
      colorKey: t.colorKey,
      iconKey: t.iconKey,
      version: t.version,
    }));
  });

  ipcMain.handle(Channel.TEMPLATES_CLONE, async (_e, input: { templateId: string }) => {
    const settings = await loadSettings();
    const { resolveTemplates, templateSourceDir } = await import('@centraid/app-templates');
    const { cloneTemplate, suggestCloneIdentityFrom } = await import('@centraid/builder-harness');

    const cacheDir = templatesCacheDir(settings.activeGatewayId);
    const templates = await resolveTemplates({ cacheDir });
    const tmpl = templates.find((t) => t.id === input.templateId);
    if (!tmpl) {
      throw new Error(`Unknown template "${input.templateId}".`);
    }

    // Pick (id, name) together so both are unique. The first clone of
    // `hydrate` lands on `hydrate` / "Hydrate"; subsequent clones bump
    // to `hydrate-2` / "Hydrate 2", `-3` / " 3", etc. Display-name
    // collisions against unrelated renamed apps are caught too — the
    // pair advances in lockstep so the home shelf can never show two
    // identically-titled tiles for new clones. Uniqueness is computed
    // against the apps already on `main` (issue #137), not a local
    // workspace — the desktop no longer has one.
    const existing = await appsStoreListAppsWithMeta();
    const { id: newAppId, name: newName } = suggestCloneIdentityFrom(existing, tmpl.id, tmpl.name);

    // Clone into the new app's editing-session worktree, then publish it
    // onto `main` over HTTP. `parent` is the session's `apps/` dir; the
    // clone writes `<newAppId>/...` underneath it.
    const parent = await ensureProjectSessionAppsParent(newAppId);
    const project = await cloneTemplate({
      projectsDir: parent,
      newAppId,
      // The resolver tells us which copy is newer (cache vs bundle); clone
      // from that one so a remote update reaches users without a desktop
      // release.
      templateDir: templateSourceDir(tmpl.id, { cacheDir, source: tmpl.source }),
      newName,
      // Carry the template's description into the cloned project's
      // `app.json` so the builder topbar + home tile show something
      // meaningful out of the gate.
      newDesc: tmpl.desc,
    });

    // Automation templates may ship `{kind:'webhook',pending:true}`
    // triggers — the template author can't know the secret in advance,
    // so the clone path mints id + secret here, rewrites the manifest
    // to its provisioned form, and returns the plaintext secret to the
    // renderer to show once. App templates never have webhook triggers,
    // so this is a no-op for them. Runs BEFORE publish so the minted
    // manifest lands on `main`. URL points at the active gateway.
    const minted = await provisionAppPendingWebhooks(project.dir);
    const webhooks = minted.map((m) => ({
      automationId: m.automationId,
      ownerApp: m.ownerApp,
      webhookId: m.webhookId,
      secret: m.secret,
      url: `${settings.gatewayUrl.replace(/\/+$/, '')}/_centraid-hook/${m.webhookId}`,
    }));

    // Publish the freshly cloned app to the gateway so the iframe can
    // preview it immediately and — for automation templates — so the
    // git-store materialized `main` has an active version the OS
    // scheduler resolves code from. Best-effort: a publish failure is
    // logged but doesn't fail the clone.
    const sessionId = await ensureProjectSession(newAppId);
    await appsStorePublishApp(sessionId, newAppId, `clone ${tmpl.id}`).catch((err: unknown) => {
      console.warn(
        `[templates:clone] initial publish failed for ${newAppId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });

    // Register any automations the template shipped with the OS
    // scheduler so cron triggers fire and webhook routes resolve without
    // waiting for the next runtime start. Best-effort. Code resolves from
    // the git-store `active-main` — the same tree the scheduler bakes.
    // Only automation apps (`kind: 'automation'`) host automations.
    if (tmpl.kind === 'automation') {
      try {
        const { rows } = await listAutomations(
          localRuntimeActiveCodeAppsDir(settings.activeGatewayId),
        );
        for (const row of rows) {
          if (row.ownerApp !== newAppId) continue;
          await localRuntimeAutomationHost(settings.activeGatewayId).register(row);
        }
      } catch (err) {
        console.warn(
          `[templates:clone] host register failed for ${newAppId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return {
      project,
      template: {
        id: tmpl.id,
        name: tmpl.name,
        desc: tmpl.desc,
        colorKey: tmpl.colorKey,
        iconKey: tmpl.iconKey,
        version: tmpl.version,
        kind: tmpl.kind ?? 'app',
      },
      webhooks,
    };
  });

  // ----- Automations (issue #98) -----
  // An automation lives inside an app folder under `appsDir`
  // (`listAutomations` scans every app's active version). An
  // `automationId` IPC argument is the automation's `<appId>/<id>`
  // handle. An automation's full run ledger is its app's per-app
  // `runtime.sqlite`; the central `centraid-analytics.sqlite` holds one
  // summary row per run and is what the Executions feed + Insights read.
  // Cache one provider per gateway id — switching gateways changes the
  // active analytics DB path, and the old provider points at the
  // previous file. A per-id Map keeps every gateway's provider warm
  // across switches without re-opening on every call.
  const analyticsProviders = new Map<string, DatabaseProvider>();
  const getAnalyticsProvider = (gatewayId: string): DatabaseProvider => {
    const existing = analyticsProviders.get(gatewayId);
    if (existing) return existing;
    const provider = makeAnalyticsDbProvider(localRuntimeAnalyticsDb(gatewayId));
    analyticsProviders.set(gatewayId, provider);
    return provider;
  };
  /**
   * Run-ledger store for one run id — every run's full ledger is its
   * app's `runtime.sqlite`. An automation runId is `<appId>/<id>:...`
   * (the app id is inline, under the projects `appsDir`); a chat runId
   * is a bare UUID, so its owning app comes from the central run summary
   * and the file is under the embedded runtime's apps dir. Returns
   * undefined when the run can't be located.
   */
  const runsStoreForRunId = async (runId: string): Promise<AutomationRunsStore | undefined> => {
    const settings = await loadSettings();
    const slash = runId.indexOf('/');
    if (slash > 0) {
      return new AutomationRunsStore(
        makeRuntimeDbProvider(path.join(settings.appsDir, runId.slice(0, slash), 'runtime.sqlite')),
      );
    }
    const summary = new AnalyticsStore(getAnalyticsProvider(settings.activeGatewayId)).getSummary(
      runId,
    );
    if (!summary?.appId) return undefined;
    return new AutomationRunsStore(
      makeRuntimeDbProvider(
        path.join(
          await localRuntimeAppsDir(settings.activeGatewayId),
          summary.appId,
          'runtime.sqlite',
        ),
      ),
    );
  };
  /** Map a central run summary into the `AutomationRunRow` feed shape. */
  const summaryToRunRow = (s: RunSummary): AutomationRunRow => ({
    runId: s.runId,
    kind: s.kind,
    ...(s.automationRef !== undefined ? { automationId: s.automationRef } : {}),
    triggerKind: s.trigger as AutomationTriggerKind,
    ...(s.triggerOrigin !== undefined
      ? { triggerOrigin: s.triggerOrigin as AutomationTriggerOrigin }
      : {}),
    ...(s.appId !== undefined ? { appId: s.appId } : {}),
    ...(s.note !== undefined ? { note: s.note } : {}),
    ...(s.retryOf !== undefined ? { retryOf: s.retryOf } : {}),
    startedAt: s.startedAt,
    ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
    ok: s.ok,
    ...(s.error !== undefined ? { error: s.error } : {}),
    ...(s.summary !== undefined ? { summary: s.summary } : {}),
    pinned: s.pinned ?? false,
    ...(s.totalInputTokens !== undefined ? { totalInputTokens: s.totalInputTokens } : {}),
    ...(s.totalOutputTokens !== undefined ? { totalOutputTokens: s.totalOutputTokens } : {}),
    ...(s.totalCacheReadTokens !== undefined
      ? { totalCacheReadTokens: s.totalCacheReadTokens }
      : {}),
    ...(s.totalCacheWriteTokens !== undefined
      ? { totalCacheWriteTokens: s.totalCacheWriteTokens }
      : {}),
    ...(s.totalCostUsd !== undefined ? { totalCostUsd: s.totalCostUsd } : {}),
    ...(s.stepCount !== undefined ? { stepCount: s.stepCount } : {}),
    ...(s.toolCount !== undefined ? { toolCount: s.toolCount } : {}),
  });

  ipcMain.handle(Channel.AUTOMATIONS_LIST, async (): Promise<AutomationRow[]> => {
    // Automations are CODE — read them from the git-store materialized
    // `main` (issue #137). For a remote active gateway there's no local
    // git store, so the dir is absent and `listAutomations` returns [].
    const settings = await loadSettings();
    const { rows } = await listAutomations(localRuntimeActiveCodeAppsDir(settings.activeGatewayId));
    return rows;
  });

  ipcMain.handle(
    Channel.AUTOMATIONS_READ,
    async (_e, input: { automationId: string }): Promise<AutomationRow | null> => {
      const settings = await loadSettings();
      const ref = parseAutomationRef(input.automationId);
      if (!ref) return null;
      const row = await readAppOwnedAutomation(
        localRuntimeActiveCodeAppsDir(settings.activeGatewayId),
        ref.appId,
        ref.automationId,
      ).catch(() => undefined);
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
            url: `${settings.gatewayUrl.replace(/\/+$/, '')}/_centraid-hook/${id}`,
          };
          return { kind: 'webhook', id, secretHash: hashWebhookSecret(secret) };
        }
        return { kind: 'cron', expr: t.expr };
      });

      // `input.id` is the automation app's folder id (a plain slug; the
      // app marks itself `kind: 'automation'` in its `app.json`).
      // Scaffold into the app's editing-session worktree, then publish
      // it onto `main` so the materialized tree the OS scheduler reads
      // has the new automation's code.
      const parent = await ensureProjectSessionAppsParent(input.id);
      await scaffoldAutomationProject(parent, input.id, {
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
      // Publish synchronously so the OS-scheduler registration below
      // reads the new manifest from the git-store materialized `main`.
      const sessionId = await ensureProjectSession(input.id);
      await appsStorePublishApp(sessionId, input.id, `scaffold automation ${input.id}`).catch(
        (err: unknown) => {
          console.warn(
            `[automations] initial publish failed for ${input.id}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        },
      );
      const { rows } = await listAutomations(
        localRuntimeActiveCodeAppsDir(settings.activeGatewayId),
      );
      const row = rows.find((r) => r.ownerApp === input.id);
      if (!row) throw new Error(`automation app ${input.id}: scaffolded but not found on main`);
      try {
        await localRuntimeAutomationHost(settings.activeGatewayId).register(row);
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
    async (_e, input: { automationId: string }): Promise<{ runId: string }> => {
      const settings = await loadSettings();
      const prefs = await loadRunnerPrefs();
      // The renderer opens the run viewer on this id and polls the
      // ledger for live progress, so the run id is minted here and the
      // fire runs in the background — a handler failure surfaces as a
      // failed run row, not a rejected invoke.
      const runId = `${input.automationId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
      void runAutomationLocal({
        automationRef: input.automationId,
        runId,
        // Data (run ledger) → gateway apps dir; code (manifest +
        // handler) → git-store materialized `main` (issue #137).
        appsDir: settings.appsDir,
        codeAppsDir: localRuntimeActiveCodeAppsDir(settings.activeGatewayId),
        analytics: new AnalyticsStore(getAnalyticsProvider(settings.activeGatewayId)),
        runner: prefs.kind,
        // "Run now" is a manual fire — tag it so the executions log
        // distinguishes it from the OS-scheduler trigger.
        triggerKind: 'manual',
        triggerOrigin: 'manual',
      }).catch((err: unknown) => {
        console.error(
          `[automations] run-now ${input.automationId} threw: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      });
      return { runId };
    },
  );

  ipcMain.handle(
    Channel.AUTOMATIONS_SET_ENABLED,
    async (_e, input: { automationId: string; enabled: boolean }) => {
      // `manifest.enabled` is the source of truth — toggling rewrites
      // the automation.json in the app's editing-session worktree, then
      // publishes onto `main` so the OS scheduler reads the new value
      // from the fresh materialized tree (issue #137).
      const settings = await loadSettings();
      const ref = parseAutomationRef(input.automationId);
      if (!ref) return { ok: true };
      const appDir = await ensureProjectSessionDir(ref.appId);
      const sessionAutoDir = path.join(appDir, APP_AUTOMATIONS_SUBDIR, ref.automationId);
      const current = await readAutomationProjectAt(sessionAutoDir, ref.appId);
      if (!current) return { ok: true };
      await setAutomationEnabledAt(sessionAutoDir, ref.appId, input.enabled);
      // Synchronous publish so the host register below sees the updated
      // manifest on `main`.
      const sessionId = await ensureProjectSession(ref.appId);
      await appsStorePublishApp(sessionId, ref.appId, `toggle ${ref.automationId}`).catch(
        (err: unknown) => {
          console.warn(
            `[automations] publish failed for ${input.automationId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        },
      );
      const row = await readAppOwnedAutomation(
        localRuntimeActiveCodeAppsDir(settings.activeGatewayId),
        ref.appId,
        ref.automationId,
      );
      if (row) {
        try {
          await localRuntimeAutomationHost(settings.activeGatewayId).register(row);
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
    // Delete is best-effort: tear down the OS scheduler entry, then drop
    // the automation's code from `main` (issue #137). A whole automation
    // app (`app.json#kind: 'automation'`) is removed entirely via the HTTP
    // delete; an app-owned automation just loses its `automations/<id>/`
    // subdir, published as a fresh commit.
    const settings = await loadSettings();
    try {
      await localRuntimeAutomationHost(settings.activeGatewayId).unregister(input.automationId);
    } catch (err) {
      console.warn(
        `[automations] host unregister failed for ${input.automationId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    const ref = parseAutomationRef(input.automationId);
    if (ref) {
      // Distinguish a whole automation app (`kind: 'automation'` — the app
      // exists only to host automations, so remove it wholesale) from an
      // app-owned automation (a UI app's `automations/<id>/` subdir, removed
      // in place). The kind is read from the app's `app.json` via the apps
      // list rather than inferred from the id.
      const apps = await appsStoreListAppsWithMeta().catch(() => []);
      const appKind = apps.find((a) => a.id === ref.appId)?.kind;
      if (appKind === 'automation') {
        // Whole automation app — drop the editing session, then remove
        // the app from `main` (forward commit + tag reap; registry
        // deregister fires gateway-side via onAppDeleted).
        await dropProjectSession(ref.appId);
        await appsStoreDeleteApp(ref.appId).catch((err: unknown) => {
          console.warn(
            `[automations] delete app failed for ${ref.appId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
      } else {
        // App-owned automation — drop its subdir in the session worktree,
        // then publish so `main` no longer lists it.
        const appDir = await ensureProjectSessionDir(ref.appId);
        const sessionAutoDir = path.join(appDir, APP_AUTOMATIONS_SUBDIR, ref.automationId);
        const exists = await readAutomationProjectAt(sessionAutoDir, ref.appId).catch(
          () => undefined,
        );
        if (exists) {
          await deleteAutomationAt(sessionAutoDir);
          const sessionId = await ensureProjectSession(ref.appId);
          await appsStorePublishApp(
            sessionId,
            ref.appId,
            `delete automation ${ref.automationId}`,
          ).catch((err: unknown) => {
            console.warn(
              `[automations] publish after delete failed for ${input.automationId}: ` +
                (err instanceof Error ? err.message : String(err)),
            );
          });
        }
      }
    }
    // Drop the automation's central run summaries. Its full ledger
    // (the app's `runtime.sqlite`) stays under the data dir until the
    // app's data dir is reaped.
    new AnalyticsStore(getAnalyticsProvider(settings.activeGatewayId)).deleteByRef(
      input.automationId,
    );
    return { ok: true };
  });

  // Run feed — central run summaries. `automationId` is optional: omit
  // it for the global Executions feed, pass it to scope to one handle.
  ipcMain.handle(
    Channel.AUTOMATIONS_LIST_RUNS,
    async (_e, input: { automationId?: string; limit?: number }): Promise<AutomationRunRow[]> => {
      const settings = await loadSettings();
      const analytics = new AnalyticsStore(getAnalyticsProvider(settings.activeGatewayId));
      const summaries = analytics.listSummaries({
        ...(input.automationId ? { automationRef: input.automationId } : {}),
        limit: input.limit ?? 50,
      });
      // The Automations screen only wants automation fires, not chat.
      return summaries.filter((s) => s.kind === 'automation').map(summaryToRunRow);
    },
  );

  // Single run — the full record from the run's own ledger. Unlike the
  // central summary `listRuns` returns, this carries `inputJson` /
  // `outputJson`, so the run viewer can show the run's actual output.
  ipcMain.handle(
    Channel.AUTOMATIONS_READ_RUN,
    async (_e, input: { runId: string }): Promise<AutomationRunRow | null> => {
      const store = await runsStoreForRunId(input.runId);
      return store?.getRun(input.runId) ?? null;
    },
  );

  // Run detail — the node timeline lives in the run's full ledger: the
  // owning app's `runtime.sqlite` (automation and chat alike).
  ipcMain.handle(
    Channel.AUTOMATIONS_LIST_RUN_NODES,
    async (_e, input: { runId: string }): Promise<AutomationRunNodeRow[]> => {
      const store = await runsStoreForRunId(input.runId);
      return store ? store.listNodes(input.runId) : [];
    },
  );

  // Pin / unpin a run as a replay fixture — flip it in the run's own
  // ledger and mirror the flag into the central summary so the feed and
  // Insights stay consistent.
  ipcMain.handle(
    Channel.AUTOMATIONS_PIN_RUN,
    async (_e, input: { runId: string; pinned: boolean }): Promise<{ ok: true }> => {
      const settings = await loadSettings();
      const store = await runsStoreForRunId(input.runId);
      store?.setPinned(input.runId, input.pinned);
      new AnalyticsStore(getAnalyticsProvider(settings.activeGatewayId)).setPinned(
        input.runId,
        input.pinned,
      );
      return { ok: true };
    },
  );

  // Insights — the whole screen's analytics payload in one read over the
  // central `run_summary` ledger (chat turns + automation fires).
  ipcMain.handle(
    Channel.INSIGHTS_SUMMARY,
    async (_e, input?: { windowDays?: number }): Promise<InsightsSummary> => {
      const settings = await loadSettings();
      const store = new InsightsStore(getAnalyticsProvider(settings.activeGatewayId));
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
