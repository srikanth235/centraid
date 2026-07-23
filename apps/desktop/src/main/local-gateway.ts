import { createWasmImagePreviewCodec, serve, type GatewayServeHandle } from '@centraid/gateway';
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
import {
  ensureDetachedGateway,
  getOrCreateDesktopOwnerId,
  preferEmbeddedGateway,
  probeGatewayInfo,
  readDaemonToken,
  readOwnershipStamp,
  type DetachedGatewayHandle,
} from './detached-gateway.js';
import { canControl, DEFAULT_GATEWAY_PORT } from './detached-gateway-core.js';

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
  close(): Promise<void>;
  /** Compatible with gateway HealthRegistry.registerProbe for the tunnel probe. */
  health: {
    registerProbe: (
      name: string,
      probe: () => Promise<{ status: 'ok' | 'degraded' | 'error'; detail?: string }>,
    ) => void;
  };
  vaults: {
    create: (name?: string) => { vaultId: string };
    delete: (vaultId: string) => void;
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
  return {
    url: handle.url,
    token: handle.token,
    mode: 'embedded',
    close: () => handle.close(),
    health: handle.health,
    vaults: {
      create: (name?: string) => {
        const info = handle.vaults.create(name);
        return { vaultId: info.vaultId };
      },
      delete: (vaultId: string) => {
        handle.vaults.delete(vaultId);
      },
    },
  };
}

function wrapDetached(handle: DetachedGatewayHandle): LocalGatewayRuntime {
  return {
    url: handle.url,
    token: handle.token,
    mode: 'detached',
    close: () => handle.close(),
    health: handle.health,
    vaults: handle.vaults,
  };
}

async function startEmbedded(gatewayId: string): Promise<LocalGatewayRuntime> {
  const settings = await loadPersistedSettings();
  const handle = await serve({
    previewCodec: createWasmImagePreviewCodec(),
    paths: {
      vaultDir: gatewayVaultDir(gatewayId),
      prefsFile: gatewayPrefsFile(gatewayId),
      modelCatalogFile: gatewayModelCatalogFile(gatewayId),
      templatesCacheDir: templatesCacheDir(gatewayId),
      logsDir: path.join(gatewayDir(gatewayId), 'gateway-logs'),
      ...(settings.remoteTemplatesUrl ? { remoteTemplatesUrl: settings.remoteTemplatesUrl } : {}),
    },
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

async function startDetached(gatewayId: string): Promise<LocalGatewayRuntime> {
  const ownerId = await getOrCreateDesktopOwnerId();
  const dataDir = gatewayDir(gatewayId);
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
    return startDetached(gatewayId);
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
    // H3: never restart a foreign (or probe-failed foreign) detached gateway.
    if (!preferEmbeddedGateway()) {
      const ownerId = await getOrCreateDesktopOwnerId();
      const dataDir = gatewayDir(gatewayId);
      const stamp = await readOwnershipStamp(dataDir);
      const token = await readDaemonToken(dataDir);
      const url = handles.get(gatewayId)?.url ?? `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}`;
      const probeOk = await probeGatewayInfo(url, token);
      const decision = canControl(stamp, ownerId, { probeOk });
      if (decision === 'foreign' || decision === 'probe-failed-refuse') {
        throw new Error(
          'This local gateway is owned by another process (CLI or service) and ' +
            'will not be restarted from the desktop. Stop it from the shell or ' +
            'leave it running.',
        );
      }
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
 * The local gateway's vault registry — create/delete are admin acts (#289).
 * Embedded uses the in-process registry; detached shells out to the same
 * `centraid-gateway vault …` CLI (H6).
 */
function localVaults(gatewayId: string): LocalGatewayRuntime['vaults'] {
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
