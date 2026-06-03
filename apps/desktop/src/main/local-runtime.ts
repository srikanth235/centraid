import { serve, type GatewayServeHandle } from '@centraid/gateway';
import { invalidatePreflightCache } from '@centraid/agent-runtime';
import {
  gatewayAnalyticsDb,
  gatewayAppsDir,
  gatewayChatRunnerSessionsDir,
  gatewayCodeStoreDir,
  gatewayIdentityDb,
  gatewayModelCatalogFile,
} from './gateway-paths.js';
import { setLocalRuntimeInfoProvider } from './gateway-store.js';
import { desktopSessionIdFor } from './app-sessions.js';
import { loadPersistedSettings, templatesCacheDir } from './settings.js';

/**
 * Electron-flavored wrapper around `@centraid/gateway`'s `serve()`.
 *
 * The desktop hosts one runtime per local gateway and uses the same
 * orchestration the standalone daemon does — `serve()` owns the
 * Runtime + stores + chat runner construction. This file is the
 * Electron-only layer:
 *
 *   - per-gateway lifecycle (the `handles` map + `starting` dedupe)
 *   - safeStorage-backed secrets
 *   - Electron-derived paths (via `gateway-paths.ts`)
 *
 * Auth: a per-launch random bearer token is minted by `serve()`. The
 * token is handed back to the renderer as the effective `gatewayToken`
 * so the renderer's HTTP client uses it on every request — same wire
 * format as remote OpenClaw mode.
 *
 * Switching the active local gateway tears down its HTTP server, which
 * also stops that gateway's in-process cron scheduler (issue #149/#150):
 * the gateway owns scheduling internally now, so its automations only
 * fire while the gateway runs — no OS scheduler, no backfill.
 */

const handles = new Map<string, GatewayServeHandle>();
const starting = new Map<string, Promise<GatewayServeHandle>>();

// Per-gateway info provider is registered with gateway-store once on
// module load — the closure reads `handles` at lookup time, so future
// gateways come online without re-registering.
let infoProviderRegistered = false;
function ensureInfoProviderRegistered(): void {
  if (infoProviderRegistered) return;
  infoProviderRegistered = true;
  setLocalRuntimeInfoProvider((gatewayId) => {
    const h = handles.get(gatewayId);
    return h ? { url: h.url, token: h.token } : undefined;
  });
}

/**
 * Local gateway storage directory — `<userData>/gateways/<id>/apps/`.
 * The home shelf, the draft/published serving, and the dispatcher all read
 * from here (the old `centraid-preview://` protocol was retired in #141
 * Phase 4 in favor of gateway draft serving).
 */
export async function localRuntimeAppsDir(gatewayId: string): Promise<string> {
  return gatewayAppsDir(gatewayId);
}

/**
 * Identity SQLite for the given local gateway (users + prefs).
 */
export function localRuntimeGatewayDb(gatewayId: string): string {
  return gatewayIdentityDb(gatewayId);
}

/**
 * Central run-summary DB for the given local gateway.
 */
export function localRuntimeAnalyticsDb(gatewayId: string): string {
  return gatewayAnalyticsDb(gatewayId);
}

export async function ensureLocalRuntime(gatewayId: string): Promise<GatewayServeHandle> {
  ensureInfoProviderRegistered();
  const ready = handles.get(gatewayId);
  if (ready) return ready;
  const inFlight = starting.get(gatewayId);
  if (inFlight) return inFlight;
  const p = (async () => {
    const appsDir = await localRuntimeAppsDir(gatewayId);
    // The gateway owns the template catalog AND its remote refresh now
    // (issue #141, Phase 5), so pass the optional remote manifest URL down
    // — the templates route fires a one-time best-effort fetch into the
    // cache on startup. This is the last thing the desktop main process did
    // with `@centraid/app-blueprints`; with it relocated, the desktop drops
    // the dependency entirely.
    // Read the *persisted* settings, not the resolved ones: `loadSettings()`
    // resolves the active gateway, which for a local profile re-enters
    // `ensureLocalRuntime(this gatewayId)`. During our own startup the handle
    // isn't registered yet, so that re-entrant call hits the in-flight dedupe
    // and awaits the very promise we're inside — a deadlock that hangs the
    // first `getSettings()` and leaves the renderer on a blank screen. We only
    // need `remoteTemplatesUrl` here, which the persisted settings already carry.
    const settings = await loadPersistedSettings();
    const handle = await serve({
      paths: {
        appsDir,
        identityDb: localRuntimeGatewayDb(gatewayId),
        analyticsDb: localRuntimeAnalyticsDb(gatewayId),
        chatRunnerSessionDir: gatewayChatRunnerSessionsDir(gatewayId),
        // Chat picker's per-runner model catalog (issue #188): the gateway
        // seeds it with defaults and overwrites it with live self-reported
        // ids on Refresh.
        modelCatalogFile: gatewayModelCatalogFile(gatewayId),
        // Gateway owns the template catalog now (issue #141): the
        // `GET /centraid/_templates` route resolves bundle-or-cache from
        // this per-gateway cache dir, matching the old desktop IPC.
        templatesCacheDir: templatesCacheDir(gatewayId),
        ...(settings.remoteTemplatesUrl ? { remoteTemplatesUrl: settings.remoteTemplatesUrl } : {}),
      },
      // Issue #137: the local gateway owns app code as a git store too,
      // so drafts survive restarts and the publish/session HTTP surface
      // is identical to the standalone daemon.
      appsStoreRoot: gatewayCodeStoreDir(gatewayId),
      // Inject the desktop's draft-session scheme so the gateway's unified
      // chat runner edits the SAME `desktop-<appId>` worktree the renderer
      // Code tab + local builder use (issue #160). Without this the runner
      // would fall back to the host-neutral `chat-<appId>` default and chat
      // edits wouldn't show up in the Code tab.
      sessionIdFor: desktopSessionIdFor,
      // Scheduling (issue #149): the gateway owns an in-process cron
      // scheduler internally and fires automations while it runs — no OS
      // scheduler, no `centraid run-automation` subprocess. Nothing to
      // inject here.
      logTag: `local-runtime:${gatewayId}`,
    });
    handles.set(gatewayId, handle);
    return handle;
  })().finally(() => {
    starting.delete(gatewayId);
  });
  starting.set(gatewayId, p);
  return p;
}

/**
 * Stop the in-process HTTP runtime for a specific local gateway.
 * Idempotent; safe to call for unknown ids. The gateway owns an
 * in-process cron scheduler (issue #149/#150), so closing the runtime
 * also stops that gateway's automations from firing — they only run
 * while the gateway is up.
 */
export async function shutdownLocalRuntime(gatewayId: string): Promise<void> {
  const h = handles.get(gatewayId);
  if (!h) return;
  handles.delete(gatewayId);
  await h.close().catch(() => undefined);
}

/**
 * Stop every running local runtime except `exceptId` (if provided).
 * Used by the gateway-switch IPC to tear down stale HTTP servers when
 * the user activates a different gateway, so we don't accumulate
 * dormant ports across switches.
 */
export async function shutdownAllLocalRuntimesExcept(exceptId?: string): Promise<void> {
  const ids = Array.from(handles.keys()).filter((id) => id !== exceptId);
  await Promise.all(ids.map((id) => shutdownLocalRuntime(id)));
}

/**
 * Called by the settings-save IPC handler when the user's `agent.runner.*`
 * prefs may have changed. The preflight result is cached in-memory by
 * `@centraid/agent-runtime`; invalidating forces the next status
 * read to re-probe `--version`.
 */
export function noteRunnerPrefsChanged(): void {
  invalidatePreflightCache();
}
