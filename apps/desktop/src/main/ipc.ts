// governance: allow-repo-hygiene file-size-limit ipc-hub pending split per-feature handler modules (agent, chat, apps, provider) once the surface stabilizes
import { ipcMain, BrowserWindow, shell } from 'electron';
import {
  loadSettings,
  saveSettings,
  setActiveGatewayId,
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
import { refreshAuthInjector } from './auth-injector.js';
import { resetChatHistoryAuthCache } from './chat-history-client.js';
import { resetUserPrefsAuthCache } from './user-prefs-client.js';
import { resetAppsStoreAuthCache } from './apps-store-client.js';
import { ensureAppSessionDir, resetAppSessions } from './app-sessions.js';

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

  // App create/files/write/delete/update-meta + publish moved to the
  // renderer's direct HTTP client (renderer/gateway-client.ts). The preview
  // iframe now points at the gateway draft URL (Phase 4), so only the
  // local-only reveal-in-Finder stays on IPC.
  APPS_OPEN: 'centraid:apps:open',

  // The in-process AGENT_* builder retired with the unified chat (issue
  // #141, Phase 3): the builder now streams the gateway's `/centraid/<id>/_chat`
  // SSE directly, so the agent runs server-side in the draft worktree.

  // PUBLISH + the app read surface (APP_LIVE_URL / APP_SCHEMA /
  // APP_TABLE_ROWS / APP_QUERY / APP_LOGS / APPS_DEREGISTER / VERSIONS_LIST /
  // VERSIONS_ACTIVATE) are gone — the renderer calls these gateway routes
  // directly (thin-client pivot; see renderer/gateway-client.ts).

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

  // TEMPLATES_LIST + TEMPLATES_CLONE moved to the renderer's direct HTTP
  // client — the gateway owns the catalog + clone (`POST /_apps/_clone`).

  // Gateway-side user identity + global preferences (theme, density, accent…)
  // moved to the renderer's direct HTTP client (renderer/gateway-client.ts)
  // under the thin-client pivot — pure `/_centraid-user/*` reads/writes.
  //
  // Coding-agent detection, the runner preflight, and the custom
  // OpenAI-compatible endpoint config + key all moved to the gateway (it's
  // colocated with the runner): the renderer reads `/centraid/_agents/status`
  // and `/centraid/_chat/runner-status` over HTTP.

  // Automations (issue #98): the full surface — create/enable/delete +
  // read/run/analytics + INSIGHTS_SUMMARY — moved to the renderer's direct
  // HTTP client (renderer/gateway-client.ts) under the thin-client pivot;
  // the gateway owns scaffold + webhook mint + stage + publish.
} as const;

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
    resetAppSessions();
    await refreshAuthInjector();
  };

  // ----- Settings -----
  // The bearer token reaches the renderer only through `getGatewayAuth()`
  // (the single bridge crossing post thin-client pivot), so the broad
  // settings payload no longer carries `gatewayToken` — nothing in the
  // renderer reads it off `getSettings()`.
  ipcMain.handle(Channel.SETTINGS_GET, async () => {
    const { gatewayToken: _gatewayToken, ...rest } = await loadSettings();
    return rest;
  });
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
  // pivot.
  //
  // Coding-agent detection + the custom OpenAI-compatible endpoint config
  // also left the main process: the gateway is colocated with the runner, so
  // it owns both the credential probe (`GET /centraid/_agents/status`) and
  // the runner preflight (`GET /centraid/_chat/runner-status`). The renderer
  // reads them over HTTP via `renderer/gateway-client-chat.ts` — a remote
  // gateway reports its own host's agents.

  // ----- Apps (issue #137: git-store backend; #141: thin client) -----
  // App lifecycle (create/files/write/delete/update-meta) + publish moved to
  // the renderer's direct HTTP client (renderer/gateway-client.ts) under the
  // thin-client pivot: the renderer opens its own editing session per app
  // (same `desktop-<id>` id the local agent uses, so they share one draft)
  // and the gateway owns scaffold/clone/meta/publish. APPS_OPEN stays on
  // IPC — a deliberately LOCAL-ONLY reveal-in-Finder that needs the on-disk
  // session worktree. The preview iframe now points at the gateway draft URL
  // (`/centraid/_draft/<sessionId>/<id>/`, resolved renderer-side via
  // `draftPreviewUrl`), so no APPS_PREVIEW_URL handler is needed.

  ipcMain.handle(Channel.APPS_OPEN, async (_e, input: { id: string }) => {
    // Reveal-in-Finder: opens the on-disk session worktree. One of the two
    // deliberately LOCAL-ONLY handlers (issue #141) — a remote gateway
    // exposes no worktree over the filesystem. The renderer hides this for
    // remote; `ensureAppSessionDir` (via `assertActiveGatewayLocal`) is
    // the backstop and throws a clear error if it's ever reached remotely.
    const dir = await ensureAppSessionDir(input.id);
    await shell.openPath(dir);
    return { ok: true };
  });

  // APPS_DELETE + APPS_UPDATE_META moved to the renderer's direct
  // HTTP client (renderer/gateway-client.ts): delete is a `DELETE /_apps/<id>`
  // + session close; meta is a `POST /_apps/<id>/meta` the gateway stages +
  // publishes.

  // Snapshot of the auto-publish queue for app `id`. Cheap; safe to
  // poll from the renderer if a toast wants the latest error string.
  ipcMain.handle(
    Channel.PUBLISH_STATUS,
    async (_e, input: { id: string }): Promise<PublishStatus> => getPublishStatus(input.id),
  );

  // ----- Publish + versions (issue #137; #141: thin client) -----
  // PUBLISH moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts): the renderer holds the editing session and
  // POSTs `…/publish` directly. VERSIONS_LIST / VERSIONS_ACTIVATE moved there
  // too (pure git-store tag reads + a forward-only rollback POST).

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
  // TEMPLATES_LIST + TEMPLATES_CLONE moved to the renderer's direct HTTP
  // client (renderer/gateway-client.ts) under the thin-client pivot — the
  // gateway owns the catalog (`GET /centraid/_templates`) and the clone
  // orchestration (`POST /centraid/_apps/_clone`: scaffold + webhook mint +
  // stage + publish). The remote gateway never needs the desktop catalog.

  // ----- Automations (issue #98; #141: thin client) -----
  // Automation create/enable/delete + the read/run/analytics surface moved
  // to the renderer's direct HTTP client (renderer/gateway-client.ts): the
  // gateway owns scaffold + webhook mint + stage + publish
  // (`POST /centraid/_automations`, `…/set-enabled`, `DELETE …`). The gateway
  // owns the materialized `main` (code), the per-app `runtime.sqlite`
  // ledgers, and the central analytics DB.

  // The run feed / single-run / node-timeline / pin-run reads and
  // INSIGHTS_SUMMARY moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) under the thin-client pivot — they were
  // pure proxies over the gateway's `/centraid/_automations` +
  // `/centraid/_insights` routes with no main-side state.
}
