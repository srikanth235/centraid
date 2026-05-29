// governance: allow-repo-hygiene file-size-limit ipc-hub pending split per-feature handler modules (agent, chat, projects, provider) once the surface stabilizes
import { ipcMain, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { promises as fs } from 'node:fs';
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
import { fetchUserPrefs, resetUserPrefsAuthCache } from './user-prefs-client.js';
import {
  deleteApp as appsStoreDeleteApp,
  listAppsWithMeta as appsStoreListAppsWithMeta,
  publishApp as appsStorePublishApp,
  readDraftFiles as appsStoreReadDraftFiles,
  resetAppsStoreAuthCache,
  listGitVersions as appsStoreListGitVersions,
  writeDraftFile as appsStoreWriteDraftFile,
  writeDraftFiles as appsStoreWriteDraftFiles,
  deleteDraftFiles as appsStoreDeleteDraftFiles,
  listAutomationsHttp,
} from './apps-store-client.js';
import {
  dropProjectSession,
  ensureProjectSession,
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
  localRuntimeCodexHomeBaseDir,
  noteRunnerPrefsChanged,
  resolveProviderPrefs,
} from './local-runtime.js';
import { runPreflight, type OpenAICompatProvider, type RunnerPrefs } from '@centraid/agent-runtime';
import {
  parseAutomationRef,
  generateWebhookId,
  generateWebhookSecret,
  hashWebhookSecret,
  provisionAppPendingWebhooks,
  provisionPendingWebhooksInFiles,
  WEBHOOK_ROUTE_PREFIX,
  type ProvisionedWebhook,
  type AutomationRow,
  type AutomationTrigger,
  type AutomationHistoryKeep,
  type RunnerStatus,
} from '@centraid/runtime-core';
import { clearProviderApiKey, hasProviderApiKey, setProviderApiKey } from './provider-secrets.js';
import { disposeWindowChatSessions } from './chat.js';
import type { ProjectInfo } from '@centraid/builder-harness';

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
 * Synthesize a `ProjectInfo` for the HTTP scaffold/clone path (issue
 * #141). The git store is the source of truth post-publish, so the
 * desktop no longer holds a local worktree to stat — `dir` is empty and
 * `built` is false. The renderer reads only `id` (+ optional
 * name/description/kind) off a create/clone return; the canonical
 * metadata flows back through `listProjects()` once the publish lands.
 */
function httpProjectInfo(
  id: string,
  meta: { name?: string; description?: string; kind?: 'app' | 'automation' } = {},
): ProjectInfo {
  return {
    id,
    dir: '',
    built: false,
    modifiedAt: new Date().toISOString(),
    ...(meta.name !== undefined ? { name: meta.name } : {}),
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.kind !== undefined ? { kind: meta.kind } : {}),
  };
}

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
  // APP_LIVE_URL / APP_SCHEMA / APP_TABLE_ROWS / APP_QUERY / APP_LOGS /
  // APPS_DEREGISTER / VERSIONS_LIST / VERSIONS_ACTIVATE are gone — the
  // renderer calls these gateway routes directly (thin-client pivot; see
  // renderer/gateway-client.ts).

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
  // Thin-client: hands the renderer the active gateway's HTTP base URL +
  // bearer token so it can call the runtime/data plane directly. Main
  // still owns where the token lives (keychain-backed settings); this is
  // the single point where it crosses to the renderer.
  GATEWAY_AUTH_GET: 'centraid:gateways:auth',

  TEMPLATES_LIST: 'centraid:templates:list',
  TEMPLATES_CLONE: 'centraid:templates:clone',

  AUTH_STATUS: 'centraid:auth:status',
  AUTH_RESYNC: 'centraid:auth:resync',

  // Gateway-side user identity + global preferences (theme, density, accent…)
  // moved to the renderer's direct HTTP client (renderer/gateway-client.ts)
  // under the thin-client pivot — pure `/_centraid-user/*` reads/writes.

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
  // owned by app folders under `appsDir`. Only the create/enable/delete
  // mutators stay on IPC (they orchestrate scaffold + session + publish);
  // the read/run/analytics surface (list/read/run-now/list-runs/read-run/
  // list-run-nodes/pin-run) + INSIGHTS_SUMMARY moved to the renderer's
  // direct HTTP client (renderer/gateway-client.ts) under the thin-client
  // pivot — they were pure gateway proxies.
  AUTOMATIONS_CREATE: 'centraid:automations:create',
  AUTOMATIONS_SET_ENABLED: 'centraid:automations:set-enabled',
  AUTOMATIONS_DELETE: 'centraid:automations:delete',
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
  // USER_ID_GET / USER_PREFS_GET / USER_PREFS_SAVE moved to the renderer's
  // direct HTTP client (renderer/gateway-client.ts) under the thin-client
  // pivot. The preflight-cache drop that rode prefs-save is no longer needed
  // here: the cache keys on the runner prefs that matter and the
  // runner-status read (RUNNER_STATUS_GET) force-invalidates before probing.
  // The main process still reads prefs internally via `fetchUserPrefs` in
  // `loadRunnerPrefs` below.

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
      const { scaffoldProjectFiles, HarnessError } = await import('@centraid/builder-harness');
      // Reject a collision with an app already on `main` so a create never
      // clobbers an existing app's draft (the FS scaffolder used to guard
      // this via a dir-exists check; the git-store path checks the list).
      const existing = await appsStoreListAppsWithMeta();
      if (existing.some((a) => a.id === input.id)) {
        throw new HarnessError('already_exists', `Project "${input.id}" already exists.`);
      }
      // Build the canonical file map (validates the id) and push it into
      // the app's editing session over HTTP — no local worktree path, so
      // this works against a remote gateway too.
      const files = scaffoldProjectFiles(input.id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.version !== undefined ? { version: input.version } : {}),
      });
      const sessionId = await ensureProjectSession(input.id);
      await appsStoreWriteDraftFiles(sessionId, input.id, files);
      // Initial publish so the fresh app is browsable in the iframe
      // without waiting for a first edit.
      await appsStorePublishApp(sessionId, input.id, `scaffold ${input.id}`).catch(() => undefined);
      return httpProjectInfo(input.id, input.name !== undefined ? { name: input.name } : {});
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
    // Reveal-in-Finder: opens the on-disk session worktree. One of the two
    // deliberately LOCAL-ONLY handlers (issue #141) — a remote gateway
    // exposes no worktree over the filesystem. The renderer hides this for
    // remote; `ensureProjectSessionDir` (via `assertActiveGatewayLocal`) is
    // the backstop and throws a clear error if it's ever reached remotely.
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
      const { updateProjectMetaFiles } = await import('@centraid/builder-harness');
      // Read the app's current draft over HTTP, apply the {name,desc} patch
      // to the file map (rejects empty/duplicate names against the apps on
      // `main`), and write back only the changed files. No local worktree
      // path, so this works against a remote gateway.
      const sessionId = await ensureProjectSession(input.id);
      const [current, existing] = await Promise.all([
        appsStoreReadDraftFiles(sessionId, input.id),
        appsStoreListAppsWithMeta(),
      ]);
      const changed = updateProjectMetaFiles(
        current,
        input.id,
        {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
        },
        existing,
      );
      await appsStoreWriteDraftFiles(sessionId, input.id, changed);
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
      //
      // The in-process codex/claude builder is the other deliberately
      // LOCAL-ONLY surface (issue #141): it runs the binary against the
      // on-disk worktree, which only the local gateway materializes.
      // `ensureProjectSessionDir` throws a clear local-only error for a
      // remote gateway — remote editing happens through the chat surface,
      // not this builder.
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

  // Thin-client token bridge: resolve the active gateway's base URL +
  // bearer token for the renderer's direct HTTP client. The token lives
  // in keychain-backed settings; this is the only path it crosses to the
  // renderer, and it's re-fetched whenever the active gateway flips.
  ipcMain.handle(
    Channel.GATEWAY_AUTH_GET,
    async (): Promise<{ baseUrl: string; token?: string }> => {
      const settings = await loadSettings();
      return {
        baseUrl: settings.gatewayUrl.replace(/\/+$/, ''),
        token: settings.gatewayToken || undefined,
      };
    },
  );

  // VERSIONS_LIST / VERSIONS_ACTIVATE moved to the renderer's direct HTTP
  // client (`renderer/gateway-client.ts`) under the thin-client pivot —
  // pure git-store tag reads + a forward-only rollback POST, no main-side
  // state. APP_LIVE_URL / APP_SCHEMA / APP_TABLE_ROWS / APP_QUERY /
  // APP_LOGS / APPS_DEREGISTER moved there too.

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
    const { resolveTemplates, readTemplateFiles } = await import('@centraid/app-templates');
    const { cloneTemplateFiles, suggestCloneIdentityFrom } =
      await import('@centraid/builder-harness');

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

    // Read the template's files from the desktop-bundled catalog (the
    // resolver picks cache-vs-bundle so a remote update reaches users
    // without a desktop release), rewrite them in memory for the new
    // id/name, and provision any pending webhook triggers — then push the
    // result over HTTP. The remote gateway never needs the catalog.
    const templateFiles = await readTemplateFiles(tmpl, { cacheDir });
    const cloned = cloneTemplateFiles({
      newAppId,
      templateFiles,
      newName,
      // Carry the template's description into the cloned app's `app.json`
      // so the builder topbar + home tile show something meaningful.
      newDesc: tmpl.desc,
    });

    // Automation templates may ship `{kind:'webhook',pending:true}`
    // triggers — the template author can't know the secret in advance,
    // so the clone path mints id + secret here, rewrites the manifest to
    // its provisioned form, and returns the plaintext secret to the
    // renderer to show once. App templates never have webhook triggers,
    // so this is a no-op for them. Secrets are minted desktop-side; only
    // the hash is written into the manifest that lands on `main`. URL
    // points at the active gateway.
    const { files: provisioned, minted } = provisionPendingWebhooksInFiles(cloned, newAppId);
    const webhooks = minted.map((m) => ({
      automationId: m.automationId,
      ownerApp: m.ownerApp,
      webhookId: m.webhookId,
      secret: m.secret,
      url: `${settings.gatewayUrl.replace(/\/+$/, '')}/_centraid-hook/${m.webhookId}`,
    }));

    // Push the cloned file map into the new app's editing session, then
    // publish it onto `main` over HTTP so the iframe can preview it
    // immediately and — for automation templates — so the materialized
    // `main` the OS scheduler reads has an active version. Best-effort: a
    // publish failure is logged but doesn't fail the clone.
    const sessionId = await ensureProjectSession(newAppId);
    await appsStoreWriteDraftFiles(sessionId, newAppId, provisioned);
    await appsStorePublishApp(sessionId, newAppId, `clone ${tmpl.id}`).catch((err: unknown) => {
      console.warn(
        `[templates:clone] initial publish failed for ${newAppId}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    });

    // The publish above drives OS-scheduler registration: the gateway's
    // `onAppLive` reconciles the scheduler against the freshly materialized
    // `main` (issue #141, C5), so an automation template's cron triggers +
    // webhook routes resolve without the desktop registering them. The
    // local gateway runs `serve()` in-process with that reconcile wired;
    // a remote gateway reconciles its own scheduler.

    return {
      project: httpProjectInfo(newAppId, {
        name: newName,
        ...(tmpl.desc !== undefined ? { description: tmpl.desc } : {}),
        kind: tmpl.kind ?? 'app',
      }),
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
  // An automation lives inside an app folder under `appsDir`. An
  // `automationId` IPC argument is the automation's `<appId>/<id>`
  // handle. Only the create/enable/delete mutators stay on IPC — they
  // orchestrate scaffold + editing session + publish. The read/run/
  // analytics surface moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) under the thin-client pivot. The gateway
  // owns the materialized `main` (code), the per-app `runtime.sqlite`
  // ledgers, and the central analytics DB.

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
      const { scaffoldAutomationProjectFiles, HarnessError } =
        await import('@centraid/builder-harness');

      // Reject a collision with an app already on `main` so a create never
      // clobbers an existing app's draft (the FS scaffolder guarded this
      // via a dir-exists check; the git-store path checks the list).
      const existingApps = await appsStoreListAppsWithMeta();
      if (existingApps.some((a) => a.id === input.id)) {
        throw new HarnessError('already_exists', `Automation app "${input.id}" already exists.`);
      }

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
      // app marks itself `kind: 'automation'` in its `app.json`). Build the
      // file map and push it into the app's editing session over HTTP (no
      // local worktree path → works against a remote gateway), then
      // publish onto `main`.
      const files = scaffoldAutomationProjectFiles(input.id, {
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
      const sessionId = await ensureProjectSession(input.id);
      await appsStoreWriteDraftFiles(sessionId, input.id, files);
      // Publish synchronously so the materialized `main` carries the new
      // automation. The gateway reconciles the OS scheduler on publish
      // (issue #141, C5) — the desktop no longer registers it directly.
      await appsStorePublishApp(sessionId, input.id, `scaffold automation ${input.id}`).catch(
        (err: unknown) => {
          console.warn(
            `[automations] initial publish failed for ${input.id}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        },
      );
      // Read the published row back for the renderer over HTTP (works for
      // local + remote) — the created automation is the one this app owns.
      const { rows } = await listAutomationsHttp();
      const row = rows.find((r) => r.ownerApp === input.id);
      if (!row) throw new Error(`automation app ${input.id}: scaffolded but not found on main`);
      return { row, ...(webhook ? { webhook } : {}) };
    },
  );

  // AUTOMATIONS_RUN_NOW moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) — a pure run-now POST to the gateway,
  // which fires with ITS runner + provider key and returns the run id.

  ipcMain.handle(
    Channel.AUTOMATIONS_SET_ENABLED,
    async (_e, input: { automationId: string; enabled: boolean }) => {
      // `manifest.enabled` is the source of truth — toggling rewrites the
      // automation.json in the app's editing session over HTTP, then
      // publishes onto `main`. The gateway reconciles the OS scheduler on
      // publish (issue #141, C5), so the new enabled state takes effect
      // without the desktop touching the scheduler. No local worktree path
      // → works against a remote gateway.
      const ref = parseAutomationRef(input.automationId);
      if (!ref) return { ok: true };
      const { setAutomationEnabledInFiles } = await import('@centraid/builder-harness');
      const sessionId = await ensureProjectSession(ref.appId);
      const current = await appsStoreReadDraftFiles(sessionId, ref.appId);
      const changed = setAutomationEnabledInFiles(current, ref.automationId, input.enabled);
      // Empty → automation absent or already at the requested state.
      if (changed.length === 0) return { ok: true };
      await appsStoreWriteDraftFiles(sessionId, ref.appId, changed);
      await appsStorePublishApp(sessionId, ref.appId, `toggle ${ref.automationId}`).catch(
        (err: unknown) => {
          console.warn(
            `[automations] publish failed for ${input.automationId}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        },
      );
      return { ok: true };
    },
  );

  ipcMain.handle(Channel.AUTOMATIONS_DELETE, async (_e, input: { automationId: string }) => {
    // Delete is best-effort. A whole automation app (`kind: 'automation'`)
    // is removed entirely via the HTTP app-delete; an app-owned automation
    // loses just its `automations/<id>/` subdir, published as a fresh
    // commit. Either way the gateway reconciles the OS scheduler on
    // delete/publish (issue #141, C5), so the desktop no longer unregisters
    // the scheduler entry itself.
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
        // App-owned automation — drop its `automations/<id>/` subdir in the
        // editing session over HTTP, then publish so `main` no longer lists
        // it. No local worktree path → works against a remote gateway.
        const { deleteAutomationFromFiles } = await import('@centraid/builder-harness');
        const sessionId = await ensureProjectSession(ref.appId);
        const currentFiles = await appsStoreReadDraftFiles(sessionId, ref.appId);
        const { removed } = deleteAutomationFromFiles(currentFiles, ref.automationId);
        if (removed.length > 0) {
          await appsStoreDeleteDraftFiles(sessionId, ref.appId, removed);
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
    // The automation's central run summaries + per-app ledger are left in
    // place; there's no HTTP route to purge analytics, and the desktop no
    // longer owns a local AnalyticsStore (issue #141). The history stays in
    // the central ledger (a record of past fires) until the app's data dir
    // is reaped gateway-side.
    return { ok: true };
  });

  // The run feed / single-run / node-timeline / pin-run reads and
  // INSIGHTS_SUMMARY moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) under the thin-client pivot — they were
  // pure proxies over the gateway's `/centraid/_automations` +
  // `/centraid/_insights` routes with no main-side state.
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
