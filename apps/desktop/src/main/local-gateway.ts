import type { GatewayServeHandle } from '@centraid/gateway';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  gatewayModelCatalogFile,
  gatewayVaultDir,
  LOCAL_GATEWAY_ID,
  localGatewayDataDir,
} from './gateway-paths.js';
import { desktopGatewayKeyStore } from './gateway-secrets.js';
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
import {
  ensureDetachedGateway,
  getOrCreateDesktopOwnerId,
  preferEmbeddedGateway,
  type DetachedGatewayHandle,
} from './detached-gateway.js';
import { startDesktopEmbeddedGateway } from './embedded-gateway.js';

/**
 * Electron-flavored local-gateway lifecycle (issue #351 / #468).
 *
 * By default the gateway is a **detached child** that outlives the UI
 * (H1–H4): `centraid-gateway serve` is spawned with detached stdio-ignore
 * + unref, stamped with desktop ownership, and polled until
 * `/centraid/_gateway/info` answers. Set `CENTRAID_EMBEDDED_GATEWAY=1`
 * to keep the legacy in-process `serve()` path (E2E / tests).
 *
 * Electron-only layer on top of `@centraid/gateway`:
 *   - per-gateway lifecycle (`handles` map + `starting` dedupe)
 *   - safeStorage-backed secrets (remote profiles; a local detached daemon
 *     uses the desktop-minted per-launch loopback token, issue #505 phase 7)
 *   - Electron-derived paths (via `gateway-paths.ts`)
 *   - supervision (H7): `gateway-supervisor-core` crash-loop / backoff on
 *     both embed and detached spawn failures
 *
 * Switching the active local gateway tears down its server (embedded close
 * or owned-detached SIGTERM). App quit deliberately does **not** kill
 * detached children so pairing / mobile keep working with the window closed.
 */

/** Runtime surface callers need — subset of GatewayServeHandle + mode. */
export interface LocalGatewayRuntime {
  url: string;
  token: string;
  mode: 'embedded' | 'detached';
  owned?: boolean;
  close(): Promise<void>;
  /** Compatible with gateway HealthRegistry.registerProbe for the tunnel probe. */
  health: {
    registerProbe: (
      name: string,
      probe: () => Promise<{ status: 'ok' | 'degraded' | 'error'; detail?: string }>,
    ) => void;
  };
  vaults: {
    create: (name?: string) => Promise<{ vaultId: string }>;
    delete: (vaultId: string, name: string) => Promise<void>;
  };
}

const handles = new Map<string, LocalGatewayRuntime>();
const starting = new Map<string, Promise<LocalGatewayRuntime>>();
const restarting = new Map<string, Promise<void>>();
/** Per-gateway backoff/crash-loop bookkeeping (issue #351 / H7). */
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

function wrapEmbedded(handle: GatewayServeHandle): LocalGatewayRuntime {
  const request = async (
    pathname: string,
    body: Record<string, unknown>,
    vaultId?: string,
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(pathname, `${handle.url}/`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${handle.token}`,
        'Content-Type': 'application/json',
        ...(vaultId ? { 'x-centraid-vault': vaultId } : {}),
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new Error(
        typeof result.message === 'string'
          ? result.message
          : `vault operation failed (HTTP ${response.status})`,
      );
    }
    return result;
  };
  return {
    url: handle.url,
    token: handle.token,
    mode: 'embedded',
    close: () => handle.close(),
    health: handle.health,
    vaults: {
      create: async (name?: string) => {
        const result = await request('/centraid/_vault/vaults', { name });
        if (typeof result.vaultId !== 'string') {
          throw new Error('vault create returned no vaultId');
        }
        return { vaultId: result.vaultId };
      },
      delete: async (vaultId: string, name: string) => {
        await request('/centraid/_vault/vaults:erase', { name }, vaultId);
      },
    },
  };
}

function wrapDetached(handle: DetachedGatewayHandle): LocalGatewayRuntime {
  return {
    url: handle.url,
    token: handle.token,
    mode: 'detached',
    owned: handle.owned,
    close: () => handle.close(),
    health: handle.health,
    vaults: handle.vaults,
  };
}

async function startEmbedded(gatewayId: string): Promise<LocalGatewayRuntime> {
  const settings = await loadPersistedSettings();
  const dataDir = localGatewayDataDir();
  const ownerId = await getOrCreateDesktopOwnerId();
  const token = crypto.randomBytes(32).toString('hex');
  const handle = await startDesktopEmbeddedGateway({
    dataDir,
    paths: {
      dataDir,
      vaultDir: gatewayVaultDir(gatewayId),
      cacheDir: path.join(dataDir, 'cache'),
      modelCatalogFile: gatewayModelCatalogFile(gatewayId),
      templatesCacheDir: templatesCacheDir(gatewayId),
      logsDir: path.join(dataDir, 'gateway-logs'),
    },
    keyStore: desktopGatewayKeyStore(dataDir, LOCAL_GATEWAY_ID),
    token,
    ownerEndpointId: ownerId,
    ...(settings.remoteTemplatesUrl ? { remoteTemplatesUrl: settings.remoteTemplatesUrl } : {}),
    sessionIdFor: desktopSessionIdFor,
    logTag: `local-gateway:${gatewayId}`,
  });
  handle.health.registerProbe('tunnel', async () => {
    const status = await phoneLinkStatus();
    if (status.error) return { status: 'error', detail: status.error };
    if (!status.running) return { status: 'degraded', detail: 'phone link not running' };
    return {
      status: 'ok',
      detail: `${status.devices.length} paired device${status.devices.length === 1 ? '' : 's'}`,
    };
  });
  return wrapEmbedded(handle);
}

async function startDetached(): Promise<LocalGatewayRuntime> {
  const ownerId = await getOrCreateDesktopOwnerId();
  const dataDir = localGatewayDataDir();
  // `replaceOwnedIfStale`: on launch, if we own a gateway that's still running
  // from an older build than the one on disk, respawn it instead of adopting
  // the stale daemon — so a rebuilt gateway (dev) or an updated app (prod)
  // actually takes effect. Safe now that stop waits for real exit.
  const detached = await ensureDetachedGateway({ dataDir, ownerId, replaceOwnedIfStale: true });
  // Phone tunnel lives in the Electron main process; register is a no-op on
  // detached handles (child owns its own health registry). Keep the probe
  // call for API parity.
  detached.health.registerProbe('tunnel', async () => {
    const status = await phoneLinkStatus();
    if (status.error) return { status: 'error', detail: status.error };
    if (!status.running) return { status: 'degraded', detail: 'phone link not running' };
    return {
      status: 'ok',
      detail: `${status.devices.length} paired device${status.devices.length === 1 ? '' : 's'}`,
    };
  });
  return wrapDetached(detached);
}

export async function ensureLocalGateway(gatewayId: string): Promise<LocalGatewayRuntime> {
  ensureInfoProviderRegistered();
  const ready = handles.get(gatewayId);
  if (ready) return ready;
  const inFlight = starting.get(gatewayId);
  if (inFlight) return inFlight;

  // Supervision guard (issue #351 / H7): fail fast instead of hammering
  // serve/spawn again on every caller. `restartLocalGateway` clears both
  // maps first, so a deliberate user action is never blocked by this.
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
    // Read *persisted* settings only — `loadSettings()` re-enters ensure.
    if (preferEmbeddedGateway()) {
      return startEmbedded(gatewayId);
    }
    return startDetached();
  })()
    .then((handle) => {
      supervisor.delete(gatewayId);
      nextAttemptAt.delete(gatewayId);
      handles.set(gatewayId, handle);
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
        const timer = setTimeout(() => {
          if (disposed) return;
          ensureLocalGateway(gatewayId).catch(() => {
            // Already recorded above.
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
 * Stop a local gateway. For **owned detached** children this SIGTERMs the
 * process group; foreign detached handles are left alone (H3). Idempotent.
 */
export async function shutdownLocalGateway(gatewayId: string): Promise<void> {
  const h = handles.get(gatewayId);
  if (!h) return;
  handles.delete(gatewayId);
  await h.close().catch(() => undefined);
}

/**
 * Stop local gateways except `exceptId`.
 *
 * **Detached gateways are skipped** — they outlive the UI (H1). Pass
 * `{ includeDetached: true }` only for explicit lifecycle (gateway switch
 * uses `shutdownLocalGateway` per id instead). App quit calls this with
 * defaults so only in-process embeds are closed.
 */
export async function shutdownAllLocalGatewaysExcept(
  exceptId?: string,
  options?: { includeDetached?: boolean },
): Promise<void> {
  const includeDetached = options?.includeDetached === true;
  const ids = Array.from(handles.entries())
    .filter(([id, h]) => id !== exceptId && (includeDetached || h.mode === 'embedded'))
    .map(([id]) => id);
  await Promise.all(ids.map((id) => shutdownLocalGateway(id)));
}

/**
 * Restart a local gateway: stop then start. Refuses foreign detached
 * gateways (H3). Manual restart always clears supervision bookkeeping.
 */
export async function restartLocalGateway(gatewayId: string): Promise<void> {
  const inFlight = restarting.get(gatewayId);
  if (inFlight) return inFlight;
  const p = (async () => {
    const current = handles.get(gatewayId);
    if (current?.mode === 'detached' && current.owned !== true) {
      throw new Error(
        'This local gateway is held by another process and will not be restarted ' +
          'from the desktop. Stop it from the shell or leave it running.',
      );
    }
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
 * Owner-scoped vault operations on the running local gateway.
 */
function localVaults(gatewayId: string): LocalGatewayRuntime['vaults'] {
  const h = handles.get(gatewayId);
  if (!h) throw new Error(`local gateway ${gatewayId} is not running`);
  return h.vaults;
}

/** Create a vault as the enrolled local owner. */
export async function createLocalVault(
  gatewayId: string,
  name?: string,
): Promise<{ vaultId: string }> {
  return localVaults(gatewayId).create(name);
}

/** Erase a vault through the typed-name owner ceremony. */
export async function deleteLocalVault(
  gatewayId: string,
  vaultId: string,
  name: string,
): Promise<void> {
  await localVaults(gatewayId).delete(vaultId, name);
}
