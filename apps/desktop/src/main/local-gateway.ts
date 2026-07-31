import crypto from "node:crypto";
import path from "node:path";

import type { GatewayServeHandle } from "@centraid/gateway";

import { desktopSessionIdFor } from "./app-sessions.js";
import {
  ensureDetachedGateway,
  getOrCreateDesktopOwnerId,
  preferEmbeddedGateway,
} from "./detached-gateway.js";
import type { DetachedGatewayHandle } from "./detached-gateway.js";
import { startDesktopEmbeddedGateway } from "./embedded-gateway.js";
import {
  gatewayModelCatalogFile,
  gatewayVaultDir,
  LOCAL_GATEWAY_ID,
  localGatewayDataDir,
} from "./gateway-paths.js";
import { desktopGatewayKeyStore } from "./gateway-secrets.js";
import { setLocalGatewayInfoProvider } from "./gateway-store.js";
import {
  backoffForAttempt,
  claimManualRetry,
  claimRevival,
  initialSupervisorState,
  recordFailure,
} from "./gateway-supervisor-core.js";
import type {
  RevivalBudget,
  SupervisorState,
} from "./gateway-supervisor-core.js";
import { phoneLinkStatus } from "./phone-link.js";
import { loadPersistedSettings, templatesCacheDir } from "./settings.js";

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
  mode: "embedded" | "detached";
  owned?: boolean;
  /** Detached child's pid — the liveness check `reviveLocalGatewayIfDead` needs. */
  pid?: number;
  close: () => Promise<void>;
  /** Compatible with gateway HealthRegistry.registerProbe for the tunnel probe. */
  health: {
    registerProbe: (
      name: string,
      probe: () => Promise<{
        status: "ok" | "degraded" | "error";
        detail?: string;
      }>
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
export function getLocalGatewaySupervisorState(
  gatewayId: string
): SupervisorState {
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
    vaultId?: string
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(pathname, `${handle.url}/`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${handle.token}`,
        "Content-Type": "application/json",
        ...(vaultId ? { "x-centraid-vault": vaultId } : {}),
      },
      body: JSON.stringify(body),
    });
    const result = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new Error(
        typeof result.message === "string"
          ? result.message
          : `vault operation failed (HTTP ${response.status})`
      );
    }
    return result;
  };
  return {
    url: handle.url,
    token: handle.token,
    mode: "embedded",
    close: () => handle.close(),
    health: handle.health,
    vaults: {
      create: async (name?: string) => {
        const result = await request("/centraid/_vault/vaults", { name });
        if (typeof result.vaultId !== "string") {
          throw new Error("vault create returned no vaultId");
        }
        return { vaultId: result.vaultId };
      },
      delete: async (vaultId: string, name: string) => {
        await request("/centraid/_vault/vaults:erase", { name }, vaultId);
      },
    },
  };
}

function wrapDetached(handle: DetachedGatewayHandle): LocalGatewayRuntime {
  return {
    url: handle.url,
    token: handle.token,
    mode: "detached",
    owned: handle.owned,
    pid: handle.pid,
    close: () => handle.close(),
    health: handle.health,
    vaults: handle.vaults,
  };
}

async function startEmbedded(gatewayId: string): Promise<LocalGatewayRuntime> {
  const settings = await loadPersistedSettings();
  const dataDir = localGatewayDataDir();
  const ownerId = await getOrCreateDesktopOwnerId();
  const token = crypto.randomBytes(32).toString("hex");
  const handle = await startDesktopEmbeddedGateway({
    dataDir,
    paths: {
      dataDir,
      vaultDir: gatewayVaultDir(gatewayId),
      cacheDir: path.join(dataDir, "cache"),
      modelCatalogFile: gatewayModelCatalogFile(gatewayId),
      templatesCacheDir: templatesCacheDir(gatewayId),
      logsDir: path.join(dataDir, "gateway-logs"),
    },
    keyStore: desktopGatewayKeyStore(dataDir, LOCAL_GATEWAY_ID),
    token,
    ownerEndpointId: ownerId,
    ...(settings.remoteTemplatesUrl
      ? { remoteTemplatesUrl: settings.remoteTemplatesUrl }
      : {}),
    sessionIdFor: desktopSessionIdFor,
    logTag: `local-gateway:${gatewayId}`,
  });
  handle.health.registerProbe("tunnel", async () => {
    const status = await phoneLinkStatus();
    if (status.error) return { status: "error", detail: status.error };
    if (!status.running)
      return { status: "degraded", detail: "phone link not running" };
    return {
      status: "ok",
      detail: `${status.devices.length} paired device${status.devices.length === 1 ? "" : "s"}`,
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
  const detached = await ensureDetachedGateway({
    dataDir,
    ownerId,
    replaceOwnedIfStale: true,
  });
  // Phone tunnel lives in the Electron main process; register is a no-op on
  // detached handles (child owns its own health registry). Keep the probe
  // call for API parity.
  detached.health.registerProbe("tunnel", async () => {
    const status = await phoneLinkStatus();
    if (status.error) return { status: "error", detail: status.error };
    if (!status.running)
      return { status: "degraded", detail: "phone link not running" };
    return {
      status: "ok",
      detail: `${status.devices.length} paired device${status.devices.length === 1 ? "" : "s"}`,
    };
  });
  return wrapDetached(detached);
}

export async function ensureLocalGateway(
  gatewayId: string
): Promise<LocalGatewayRuntime> {
  ensureInfoProviderRegistered();
  // A cached handle is returned as-is, deliberately: this function is called
  // from every settings read (including the monitor's own 5s tick), so putting
  // "is it still alive? then respawn" here would restart a crash-looping daemon
  // on every tick with no budget. `reviveLocalGatewayIfDead` is the single
  // owner of that decision and is rate-limited — see its comment block.
  const ready = handles.get(gatewayId);
  if (ready) return ready;
  const inFlight = starting.get(gatewayId);
  if (inFlight) return inFlight;

  // Supervision guard (issue #351 / H7): fail fast instead of hammering
  // serve/spawn again on every caller. `restartLocalGateway` clears both
  // maps first, so a deliberate user action is never blocked by this.
  const sup = supervisor.get(gatewayId);
  if (sup?.loopBroken) {
    // No recovery instruction in the message. This string is quoted verbatim
    // on the startup error screen, which has no sidebar and no navigation —
    // telling that reader to "use Settings → Gateway → Restart" pointed at a
    // surface they cannot reach, and quitting the app was the only real exit.
    // The recovery now lives where the message is READ: the screen's "Try
    // again" button routes through `retryLocalGatewayStart`, which clears this
    // very latch. In the running shell the Gateway page still offers Restart.
    throw new Error(
      `local gateway "${gatewayId}" failed to start repeatedly and stopped retrying` +
        (sup.lastError ? ` (last error: ${sup.lastError})` : "")
    );
  }
  const waitUntil = nextAttemptAt.get(gatewayId);
  if (waitUntil !== undefined && Date.now() < waitUntil) {
    throw new Error(
      `local gateway "${gatewayId}" is backing off after a failed start; retrying automatically` +
        (sup?.lastError ? ` (last error: ${sup.lastError})` : "")
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
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const prev = supervisor.get(gatewayId) ?? initialSupervisorState();
      const next = recordFailure(prev, Date.now(), message);
      supervisor.set(gatewayId, next);
      if (next.loopBroken) {
        nextAttemptAt.delete(gatewayId);
      } else {
        const delay = backoffForAttempt(next.attempt);
        nextAttemptAt.set(gatewayId, Date.now() + delay);
        const timer = setTimeout(() => {
          if (disposed) return;
          ensureLocalGateway(gatewayId).catch(() => {
            // Already recorded above.
          });
        }, delay);
        timer.unref?.();
      }
      throw error;
    })
    .finally(() => {
      starting.delete(gatewayId);
    });
  starting.set(gatewayId, p);
  return p;
}

/*
 * Revival of an owned detached daemon that DIED after a successful start.
 *
 * `ensureLocalGateway` returns its cached handle without a liveness check, so
 * once the desktop's own daemon was killed the UI correctly said "Gateway down"
 * and nothing ever brought it back — the handle in `handles` still looked fine
 * and the supervisor only ever sees *start* failures, never post-start death.
 *
 * The trigger is deliberately narrow so this cannot become a hot restart loop:
 *
 *   - only an OWNED detached gateway (embedded ones die with the process;
 *     foreign daemons are not ours to restart, H3);
 *   - only when the pid is actually GONE. A daemon that is merely wedged or
 *     slow still holds gateway.db, and respawning against it would either be
 *     refused or start a second writer — so an unreachable-but-alive daemon is
 *     left to the down alert;
 *   - inside the `claimRevival` budget (gateway-supervisor-core.ts): a daemon
 *     that dies immediately every time stops being respawned after a few tries
 *     instead of being restarted on every monitor tick forever, and the crash
 *     loop surfaces through the existing supervisor/down alerts instead.
 */
const revivals = new Map<string, RevivalBudget>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Called by the gateway monitor when its heartbeat fails. Drops the stale
 * cached handle and re-runs `ensureLocalGateway` when — and only when — the
 * owned detached daemon behind it is really gone. Resolves to whether a
 * revival was started; never rejects (the retry bookkeeping in
 * `ensureLocalGateway` already records the failure).
 */
export async function reviveLocalGatewayIfDead(
  gatewayId: string
): Promise<boolean> {
  if (disposed) return false;
  const current = handles.get(gatewayId);
  if (!current || current.mode !== "detached" || current.owned !== true) {
    return false;
  }
  if (current.pid === undefined || pidAlive(current.pid)) return false;
  const claim = claimRevival(revivals.get(gatewayId), Date.now());
  revivals.set(gatewayId, claim.next);
  if (!claim.allowed) return false;
  process.stdout.write(
    `[local-gateway] owned daemon pid ${current.pid} is gone; respawning "${gatewayId}"\n`
  );
  handles.delete(gatewayId);
  await ensureLocalGateway(gatewayId).catch((error: unknown) => {
    // Recorded by the supervisor inside ensureLocalGateway; keep the monitor
    // tick alive rather than turning a failed respawn into a crash-log entry.
    process.stdout.write(
      `[local-gateway] respawn of "${gatewayId}" failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });
  return true;
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
  options?: { includeDetached?: boolean }
): Promise<void> {
  const includeDetached = options?.includeDetached === true;
  const ids = Array.from(handles.entries())
    .filter(
      ([id, h]) => id !== exceptId && (includeDetached || h.mode === "embedded")
    )
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
    if (current?.mode === "detached" && current.owned !== true) {
      throw new Error(
        "This local gateway is held by another process and will not be restarted " +
          "from the desktop. Stop it from the shell or leave it running."
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

/*
 * "Try again", pressed by a member who cannot reach Settings.
 *
 * The startup error screen appears when the shell could not READ its settings,
 * which on this desktop almost always means the local gateway would not start.
 * Once `ensureLocalGateway` has latched `loopBroken`, every subsequent read
 * fails instantly from the guard above — so a button that only re-read the
 * settings was dead the moment it appeared, even after the user had removed
 * the cause entirely (killed the process holding gateway.db, restored the
 * device credential file). It is the same recovery the Gateway page's Restart
 * offers, reachable from a screen that has no Gateway page.
 *
 * Clearing the automatic budgets is the whole point — see the tradeoff written
 * out at `claimManualRetry` in gateway-supervisor-core.ts. The floor there is
 * the only thing that survives, so leaning on the button costs one start
 * attempt per press rather than one per event-loop turn.
 */
const lastManualRetryAt = new Map<string, number>();
const manualRetryInFlight = new Map<string, Promise<void>>();

/**
 * Clear every give-up latch for `gatewayId` and start it again. Rejects with
 * the start failure so the caller can report why the retry did not take.
 */
export async function retryLocalGatewayStart(gatewayId: string): Promise<void> {
  const claim = claimManualRetry(lastManualRetryAt.get(gatewayId), Date.now());
  const pending = manualRetryInFlight.get(gatewayId);
  // Inside the floor the press is collapsed into the previous one: the caller
  // still gets a truthful outcome, just not a second spawn.
  if (!claim.allowed && pending) return pending;
  lastManualRetryAt.set(gatewayId, claim.next);
  // The revival budget belongs to the monitor's automatic respawns; a human
  // asking for a start hands it back a full one. `restartLocalGateway` clears
  // the start-failure supervisor state (`loopBroken`) and the backoff deadline,
  // then runs the same stop → start a manual Restart does.
  revivals.delete(gatewayId);
  const p = restartLocalGateway(gatewayId);
  manualRetryInFlight.set(gatewayId, p);
  return p;
}

/**
 * Owner-scoped vault operations on the running local gateway.
 */
function localVaults(gatewayId: string): LocalGatewayRuntime["vaults"] {
  const h = handles.get(gatewayId);
  if (!h) throw new Error(`local gateway ${gatewayId} is not running`);
  return h.vaults;
}

/** Create a vault as the enrolled local owner. */
export async function createLocalVault(
  gatewayId: string,
  name?: string
): Promise<{ vaultId: string }> {
  return localVaults(gatewayId).create(name);
}

/** Erase a vault through the typed-name owner ceremony. */
export async function deleteLocalVault(
  gatewayId: string,
  vaultId: string,
  name: string
): Promise<void> {
  await localVaults(gatewayId).delete(vaultId, name);
}
