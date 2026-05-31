import {
  parseProviderPrefs,
  serve,
  type GatewayServeHandle,
  type SecretsProvider,
} from '@centraid/gateway';
import {
  defaultCentraidCliDir,
  invalidatePreflightCache,
  OsSchedulerHost,
  type OpenAICompatProvider,
} from '@centraid/agent-runtime';
import path from 'node:path';
import { getProviderApiKey } from './provider-secrets.js';
import {
  gatewayAnalyticsDb,
  gatewayAppsDir,
  gatewayChatRunnerSessionsDir,
  gatewayCodexHomeBaseDir,
  gatewayCodeStoreDir,
  gatewayIdentityDb,
} from './gateway-paths.js';
import { setLocalRuntimeInfoProvider } from './gateway-store.js';
import { loadPersistedSettings, templatesCacheDir } from './settings.js';
import type { AutomationHost } from '@centraid/app-engine';

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
 *   - OS-scheduler factory the desktop installs
 *
 * Auth: a per-launch random bearer token is minted by `serve()`. The
 * token is handed back to the renderer as the effective `gatewayToken`
 * so the renderer's HTTP client uses it on every request — same wire
 * format as remote OpenClaw mode.
 *
 * Switching the active local gateway tears down its HTTP server, but
 * automations registered with the OS scheduler keep firing — they
 * shell the CLI against the per-gateway DB paths baked into each
 * scheduler entry.
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
 * Parent directory under which provider-scoped `CODEX_HOME`s are
 * materialized when the user has configured a custom OpenAI-compatible
 * provider on the codex runner.
 */
export function localRuntimeCodexHomeBaseDir(gatewayId: string): string {
  return gatewayCodexHomeBaseDir(gatewayId);
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

/**
 * Stable path to the gateway's git-store `active-main/apps` symlink
 * target (issue #137) — where automation *code* (manifests + handlers)
 * lives. The symlink is repointed atomically by the AppsStore on every
 * publish/rollback/delete, so this path is safe to bake into OS
 * scheduler artifacts once and survives version swaps.
 */
export function localRuntimeActiveCodeAppsDir(gatewayId: string): string {
  return path.join(gatewayCodeStoreDir(gatewayId), 'active-main', 'apps');
}

/**
 * Per-gateway OS-scheduler-backed AutomationHost. Lazy: built on first
 * read so we don't shell out to the OS scheduler before anyone actually
 * toggled an automation.
 *
 * Both dirs are derived from `gatewayId` (issue #137): the scheduler
 * fires `centraid run-automation`, which resolves the automation's CODE
 * from `active-main/apps` (git store) and writes its run ledger DATA to
 * `<appsDir>/<id>/runtime.sqlite`. The host is cached per gateway, so
 * deriving both internally keeps every caller (the serve() factory + the
 * register/unregister IPCs) pointed at the same two trees.
 *
 * `centraidBin` points at the bundled CLI script. We resolve via
 * `defaultCentraidCliDir` to stay agnostic to electron-builder
 * unpacking layout.
 */
const automationHosts = new Map<string, AutomationHost>();
export function localRuntimeAutomationHost(gatewayId: string): AutomationHost {
  const existing = automationHosts.get(gatewayId);
  if (existing) return existing;
  const dataAppsDir = gatewayAppsDir(gatewayId);
  const host = new OsSchedulerHost({
    workdir: dataAppsDir,
    centraidBin: path.join(defaultCentraidCliDir(), 'centraid-cli.js'),
    analyticsDbPath: localRuntimeAnalyticsDb(gatewayId),
    appsDir: dataAppsDir,
    codeAppsDir: localRuntimeActiveCodeAppsDir(gatewayId),
    runner: 'codex',
  });
  automationHosts.set(gatewayId, host);
  return host;
}

export async function ensureLocalRuntime(gatewayId: string): Promise<GatewayServeHandle> {
  ensureInfoProviderRegistered();
  const ready = handles.get(gatewayId);
  if (ready) return ready;
  const inFlight = starting.get(gatewayId);
  if (inFlight) return inFlight;
  const p = (async () => {
    const appsDir = await localRuntimeAppsDir(gatewayId);
    const secrets: SecretsProvider = {
      getProviderApiKey: () => getProviderApiKey(gatewayId),
    };
    // The gateway owns the template catalog AND its remote refresh now
    // (issue #141, Phase 5), so pass the optional remote manifest URL down
    // — the templates route fires a one-time best-effort fetch into the
    // cache on startup. This is the last thing the desktop main process did
    // with `@centraid/app-templates`; with it relocated, the desktop drops
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
        codexHomeBaseDir: localRuntimeCodexHomeBaseDir(gatewayId),
        // Gateway owns the template catalog now (issue #141): the
        // `GET /centraid/_templates` route resolves bundle-or-cache from
        // this per-gateway cache dir, matching the old desktop IPC.
        templatesCacheDir: templatesCacheDir(gatewayId),
        ...(settings.remoteTemplatesUrl ? { remoteTemplatesUrl: settings.remoteTemplatesUrl } : {}),
      },
      secrets,
      // Issue #137: the local gateway owns app code as a git store too,
      // so drafts survive restarts and the publish/session HTTP surface
      // is identical to the standalone daemon.
      appsStoreRoot: gatewayCodeStoreDir(gatewayId),
      // Both code + data dirs are derived from `gatewayId` inside the
      // host factory (issue #137), so the dirs serve() computes are
      // advisory here — the cached host owns the canonical paths.
      schedulerHostFactory: () => localRuntimeAutomationHost(gatewayId),
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
 * Idempotent; safe to call for unknown ids. Automations registered with
 * the OS scheduler keep firing — they don't depend on the runtime
 * being up.
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

/**
 * Re-export `parseProviderPrefs` so [ipc.ts](apps/desktop/src/main/ipc.ts)
 * keeps its existing import surface (parsing has no Electron deps and
 * lives in `@centraid/gateway`).
 */
export { parseProviderPrefs };

/**
 * Build a complete `OpenAICompatProvider` by combining user_prefs-side
 * config with the safeStorage-backed API key. Used by [ipc.ts:236](apps/desktop/src/main/ipc.ts)
 * when persisting/validating provider settings from the renderer.
 *
 * The runtime's own per-turn prefs loader (inside `serve()`) goes
 * through the injected `SecretsProvider` instead — same end shape, just
 * a different code path so the gateway package stays free of
 * Electron deps.
 */
export async function resolveProviderPrefs(
  prefs: Record<string, unknown>,
  gatewayId: string,
): Promise<OpenAICompatProvider | undefined> {
  const base = parseProviderPrefs(prefs);
  if (!base) return undefined;
  if (!base.envKey) return base;
  const apiKey = await getProviderApiKey(gatewayId);
  return apiKey ? { ...base, apiKey } : base;
}
