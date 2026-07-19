import { createWasmImagePreviewCodec, serve, type GatewayServeHandle } from '@centraid/gateway';
import { invalidatePreflightCache } from '@centraid/agent-runtime';
import path from 'node:path';
import {
  gatewayDir,
  gatewayModelCatalogFile,
  gatewayPrefsFile,
  gatewayVaultDir,
} from './gateway-paths.js';
import { setLocalGatewayInfoProvider } from './gateway-store.js';
import { desktopSessionIdFor } from './app-sessions.js';
import { loadPersistedSettings, templatesCacheDir } from './settings.js';
import { phoneLinkStatus } from './phone-link.js';
import {
  backoffForAttempt,
  initialSupervisorState,
  recordFailure,
  type SupervisorState,
} from './gateway-supervisor-core.js';

/**
 * Electron-flavored wrapper around `@centraid/gateway`'s `serve()`.
 *
 * The desktop runs one embedded gateway per local profile, using the
 * same orchestration the standalone daemon does — `serve()` owns the
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
 * format as remote gateway mode.
 *
 * Switching the active local gateway tears down its HTTP server, which
 * also stops that gateway's in-process cron scheduler (issue #149/#150):
 * the gateway owns scheduling internally now, so its automations only
 * fire while the gateway runs — no OS scheduler, no backfill.
 *
 * Supervision (issue #351): a failed `serve()` used to be retried
 * immediately and unconditionally on the very next caller (every settings
 * read), which surfaced a real boot failure as silent retry-storming with
 * no user-visible signal. `gateway-supervisor-core.ts` now tracks failures
 * per gateway id: each one schedules a single backed-off retry, and
 * `ensureLocalGateway` itself fails fast (no new attempt) while a backoff
 * is pending or after the crash-loop threshold trips — see
 * `getLocalGatewaySupervisorState` / `restartLocalGateway`.
 */

const handles = new Map<string, GatewayServeHandle>();
const starting = new Map<string, Promise<GatewayServeHandle>>();
const restarting = new Map<string, Promise<void>>();
/** Per-gateway backoff/crash-loop bookkeeping (issue #351). */
const supervisor = new Map<string, SupervisorState>();
/** Epoch ms before which `ensureLocalGateway` refuses a new attempt. */
const nextAttemptAt = new Map<string, number>();
/**
 * Set once the app is quitting (main.ts's `before-quit` handler) so a
 * scheduled auto-retry timer that fires mid-teardown doesn't resurrect a
 * gateway we just told to close.
 */
let disposed = false;

export function markLocalGatewaysDisposed(): void {
  disposed = true;
}

/** Supervision snapshot for gateway `gatewayId` — empty state if it has never failed. */
export function getLocalGatewaySupervisorState(gatewayId: string): SupervisorState {
  return supervisor.get(gatewayId) ?? initialSupervisorState();
}

// Per-gateway info provider is registered with gateway-store once on
// module load — the closure reads `handles` at lookup time, so future
// gateways come online without re-registering.
let infoProviderRegistered = false;
function ensureInfoProviderRegistered(): void {
  if (infoProviderRegistered) return;
  infoProviderRegistered = true;
  setLocalGatewayInfoProvider((gatewayId) => {
    const h = handles.get(gatewayId);
    return h ? { url: h.url, token: h.token } : undefined;
  });
}

export async function ensureLocalGateway(gatewayId: string): Promise<GatewayServeHandle> {
  ensureInfoProviderRegistered();
  const ready = handles.get(gatewayId);
  if (ready) return ready;
  const inFlight = starting.get(gatewayId);
  if (inFlight) return inFlight;

  // Supervision guard (issue #351): fail fast instead of hammering `serve()`
  // again on every caller. `restartLocalGateway` (manual restart) clears
  // both maps first, so a deliberate user action is never blocked by this.
  const sup = supervisor.get(gatewayId);
  if (sup?.loopBroken) {
    throw new Error(
      `local gateway "${gatewayId}" failed to start repeatedly and stopped retrying` +
        (sup.lastError ? ` (last error: ${sup.lastError})` : '') +
        ' — use Settings → Gateway → Restart to try again.',
    );
  }
  const waitUntil = nextAttemptAt.get(gatewayId);
  if (waitUntil !== undefined && Date.now() < waitUntil) {
    throw new Error(
      `local gateway "${gatewayId}" is backing off after a failed start; retrying automatically` +
        (sup?.lastError ? ` (last error: ${sup.lastError})` : ''),
    );
  }

  const p = (async () => {
    // The gateway owns the template catalog AND its remote refresh now
    // (issue #141, Phase 5), so pass the optional remote manifest URL down
    // — the templates route fires a one-time best-effort fetch into the
    // cache on startup. This is the last thing the desktop main process did
    // with `@centraid/blueprints`; with it relocated, the desktop drops
    // the dependency entirely.
    // Read the *persisted* settings, not the resolved ones: `loadSettings()`
    // resolves the active gateway, which for a local profile re-enters
    // `ensureLocalGateway(this gatewayId)`. During our own startup the handle
    // isn't registered yet, so that re-entrant call hits the in-flight dedupe
    // and awaits the very promise we're inside — a deadlock that hangs the
    // first `getSettings()` and leaves the renderer on a blank screen. We only
    // need `remoteTemplatesUrl` here, which the persisted settings already carry.
    const settings = await loadPersistedSettings();
    const handle = await serve({
      // Keep Electron independent of native-addon ABI packaging while still
      // moving libvips work off the gateway JS implementation.
      previewCodec: createWasmImagePreviewCodec(),
      paths: {
        // The vault is the unit (#280): apps, app code, transcripts, and
        // run history all live inside the active vault's directory under
        // this registry root. Mounting it is what makes the projection
        // blueprints live — apps enroll on publish, handlers reach the
        // canon through `ctx.vault`, and the owner consent surface serves
        // under `/centraid/_vault/*`.
        vaultDir: gatewayVaultDir(gatewayId),
        // Device prefs (runner choice, theme, …) — a JSON file; the old
        // identity.sqlite is gone (#280).
        prefsFile: gatewayPrefsFile(gatewayId),
        // Chat picker's per-runner model catalog (issue #188): the gateway
        // seeds it with defaults and overwrites it with live self-reported
        // ids on Refresh.
        modelCatalogFile: gatewayModelCatalogFile(gatewayId),
        // Gateway owns the template catalog now (issue #141): the
        // `GET /centraid/_templates` route resolves bundle-or-cache from
        // this per-gateway cache dir, matching the old desktop IPC.
        templatesCacheDir: templatesCacheDir(gatewayId),
        // Persist gateway logs (issue #351) so the Logs page and the
        // diagnostics bundle survive a crash/restart — without this the
        // log store is an in-memory ring that dies with the process.
        logsDir: path.join(gatewayDir(gatewayId), 'gateway-logs'),
        ...(settings.remoteTemplatesUrl ? { remoteTemplatesUrl: settings.remoteTemplatesUrl } : {}),
      },
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
      logTag: `local-gateway:${gatewayId}`,
    });
    // The iroh phone tunnel lives in the Electron main process, outside
    // `buildGateway()` — report it through the gateway's health registry
    // so Settings → Diagnostics shows it beside the in-gateway components.
    // `phoneLinkStatus` is cheap after startup: it only retries the bind
    // when neither a handle nor a recorded start error exists.
    handle.health.registerProbe('tunnel', async () => {
      const status = await phoneLinkStatus();
      if (status.error) return { status: 'error', detail: status.error };
      if (!status.running) return { status: 'degraded', detail: 'phone link not running' };
      return {
        status: 'ok',
        detail: `${status.devices.length} paired device${status.devices.length === 1 ? '' : 's'}`,
      };
    });
    handles.set(gatewayId, handle);
    return handle;
  })()
    .then((handle) => {
      // A clean start clears any backoff/crash-loop history — a gateway
      // that's up again deserves a fresh supervision window, not one that
      // remembers failures from an hour ago.
      supervisor.delete(gatewayId);
      nextAttemptAt.delete(gatewayId);
      return handle;
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const prev = supervisor.get(gatewayId) ?? initialSupervisorState();
      const next = recordFailure(prev, Date.now(), message);
      supervisor.set(gatewayId, next);
      if (!next.loopBroken) {
        const delay = backoffForAttempt(next.attempt);
        nextAttemptAt.set(gatewayId, Date.now() + delay);
        // Auto-retry in the background so a transient startup failure heals
        // itself without requiring the user to trigger another settings
        // read or manually restart. `disposed` guards against a retry
        // firing after the app has already started quitting.
        const timer = setTimeout(() => {
          if (disposed) return;
          ensureLocalGateway(gatewayId).catch(() => {
            // Already recorded above (recursively, via this same catch) —
            // nothing further to do here.
          });
        }, delay);
        timer.unref?.();
      } else {
        nextAttemptAt.delete(gatewayId);
      }
      throw err;
    })
    .finally(() => {
      starting.delete(gatewayId);
    });
  starting.set(gatewayId, p);
  return p;
}

/**
 * Stop the in-process HTTP server for a specific local gateway.
 * Idempotent; safe to call for unknown ids. The gateway owns an
 * in-process cron scheduler (issue #149/#150), so closing it
 * also stops that gateway's automations from firing — they only run
 * while the gateway is up.
 */
export async function shutdownLocalGateway(gatewayId: string): Promise<void> {
  const h = handles.get(gatewayId);
  if (!h) return;
  handles.delete(gatewayId);
  await h.close().catch(() => undefined);
}

/**
 * Stop every running local gateway except `exceptId` (if provided).
 * Used by the gateway-switch IPC to tear down stale HTTP servers when
 * the user activates a different gateway, so we don't accumulate
 * dormant ports across switches. Called with no argument at app quit
 * (main.ts's `before-quit` handler) to close everything.
 */
export async function shutdownAllLocalGatewaysExcept(exceptId?: string): Promise<void> {
  const ids = Array.from(handles.keys()).filter((id) => id !== exceptId);
  await Promise.all(ids.map((id) => shutdownLocalGateway(id)));
}

/**
 * Restart a local gateway: graceful stop (WAL checkpoint + close, via
 * `shutdownLocalGateway`) then a fresh `ensureLocalGateway` — serialized so
 * concurrent restart requests (e.g. a double-click on the Settings button)
 * collapse onto one in-flight attempt rather than racing two `serve()`
 * calls. A manual restart always clears supervision bookkeeping first, so
 * it isn't refused by crash-loop/backoff state left over from earlier
 * automatic-retry failures — this is the one path that resets the loop
 * breaker short of the app relaunching.
 *
 * `serve()` mints a fresh per-launch bearer token when the caller doesn't
 * pass one (true here, same as first boot), so every caller MUST also
 * invalidate the renderer's HTTP-client auth caches and re-broadcast the
 * active-gateway auth after this resolves — see the `GATEWAY_RESTART` IPC
 * handler in ipc.ts, which does exactly that.
 */
export async function restartLocalGateway(gatewayId: string): Promise<void> {
  const inFlight = restarting.get(gatewayId);
  if (inFlight) return inFlight;
  const p = (async () => {
    supervisor.delete(gatewayId);
    nextAttemptAt.delete(gatewayId);
    await shutdownLocalGateway(gatewayId);
    await ensureLocalGateway(gatewayId);
  })().finally(() => {
    restarting.delete(gatewayId);
  });
  restarting.set(gatewayId, p);
  return p;
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
 * The local gateway's vault registry — the desktop IS the landlord for its
 * own in-process gateway (issue #289), so vault create/delete (admin acts,
 * off the HTTP surface) run against the registry directly, mirroring the
 * `centraid-gateway vault …` CLI. Throws if the gateway isn't running.
 */
function localVaults(gatewayId: string): GatewayServeHandle['vaults'] {
  const h = handles.get(gatewayId);
  if (!h) throw new Error(`local gateway ${gatewayId} is not running`);
  return h.vaults;
}

/** Create a vault on a running local gateway (admin act, #289). */
export function createLocalVault(gatewayId: string, name?: string): { vaultId: string } {
  const info = localVaults(gatewayId).create(name);
  return { vaultId: info.vaultId };
}

/** Delete a vault on a running local gateway (admin act, #289). */
export function deleteLocalVault(gatewayId: string, vaultId: string): void {
  localVaults(gatewayId).delete(vaultId);
}
