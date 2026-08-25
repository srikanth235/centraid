import crypto from "node:crypto";
import path from "node:path";

import type { GatewayServeHandle } from "@centraid/server";

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
import { templatesCacheDir } from "./settings.js";

/**
 * Electron-flavored local-gateway lifecycle (#351 / #468). The gateway is a
 * detached child that outlives the UI (H1–H4); `CENTRAID_EMBEDDED_GATEWAY=1`
 * selects the in-process `serve()` path for E2E and tests. This layer owns the
 * per-gateway `handles`/`starting` maps, safeStorage-backed secrets, Electron
 * paths, and supervision via `gateway-supervisor-core`.
 *
 * Switching the active gateway tears its server down. App quit deliberately
 * does NOT kill detached children — pairing and mobile keep working with the
 * window closed.
 */

export interface LocalGatewayRuntime {
  url: string;
  token: string;
  mode: "embedded" | "detached";
  owned?: boolean;
  /** Detached child's pid, for `reviveLocalGatewayIfDead`'s liveness check. */
  pid?: number;
  close: () => Promise<void>;
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
const supervisor = new Map<string, SupervisorState>();
/** Epoch ms before which `ensureLocalGateway` refuses a new attempt. */
const nextAttemptAt = new Map<string, number>();
/** Set at quit, so a scheduled auto-retry can't resurrect a closing gateway. */
let disposed = false;

export function markLocalGatewaysDisposed(): void {
  disposed = true;
}

export function getLocalGatewaySupervisorState(
  gatewayId: string
): SupervisorState {
  return supervisor.get(gatewayId) ?? initialSupervisorState();
}

// Registered once: the closure reads `handles` at lookup time, so later
// gateways need no re-registration.
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
  // `replaceOwnedIfStale` respawns an owned daemon left from an older build, so
  // a rebuild takes effect. Safe because stop waits for real exit.
  const detached = await ensureDetachedGateway({
    dataDir,
    ownerId,
    replaceOwnedIfStale: true,
  });
  // A no-op on detached handles (the child owns its health registry); kept for
  // API parity.
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
  // A cached handle is returned WITHOUT a liveness check: every settings read
  // lands here, so respawning from this path would restart a crash-looping
  // daemon every tick. `reviveLocalGatewayIfDead` is the rate-limited owner.
  const ready = handles.get(gatewayId);
  if (ready) return ready;
  const inFlight = starting.get(gatewayId);
  if (inFlight) return inFlight;

  // Fail fast rather than re-spawning per caller (#351 / H7).
  // `restartLocalGateway` clears both maps, so a user action is never blocked.
  const sup = supervisor.get(gatewayId);
  if (sup?.loopBroken) {
    // No recovery instructions in this message: it is quoted verbatim on the
    // startup error screen, which has no navigation. That screen's "Try again"
    // button clears this latch through `retryLocalGatewayStart`.
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
    // Persisted settings only: `loadSettings()` re-enters ensure.
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
 * Revival of an owned detached daemon that DIED after a successful start — the
 * supervisor sees start failures only. The trigger must stay narrow or this
 * becomes a hot restart loop: OWNED detached gateways only (H3), only once the
 * pid is really GONE (a wedged daemon still holds gateway.db, so respawning
 * would start a second writer), and only inside the `claimRevival` budget.
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

/** Never rejects: `ensureLocalGateway` already records the failure. Resolves
 *  to whether a revival was started. */
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
    // Already recorded by the supervisor; keep the monitor tick alive.
    process.stdout.write(
      `[local-gateway] respawn of "${gatewayId}" failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });
  return true;
}

/** Idempotent. Foreign detached handles are left alone (H3). */
export async function shutdownLocalGateway(gatewayId: string): Promise<void> {
  const h = handles.get(gatewayId);
  if (!h) return;
  handles.delete(gatewayId);
  await h.close().catch(() => undefined);
}

/**
 * Detached gateways are skipped by default — they outlive the UI (H1). Pass
 * `includeDetached` only for explicit lifecycle; app quit must not.
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

/** Refuses foreign detached gateways (H3); always clears supervision state. */
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
 * "Try again" from the startup error screen, which has no Gateway page. Once
 * `loopBroken` latches, a button that merely re-reads settings is dead on
 * arrival, so clearing the automatic budgets is the whole point; only
 * `claimManualRetry`'s floor survives, costing one attempt per press.
 */
const lastManualRetryAt = new Map<string, number>();
const manualRetryInFlight = new Map<string, Promise<void>>();

/** Rejects with the start failure so the caller can report why it did not take. */
export async function retryLocalGatewayStart(gatewayId: string): Promise<void> {
  const claim = claimManualRetry(lastManualRetryAt.get(gatewayId), Date.now());
  const pending = manualRetryInFlight.get(gatewayId);
  // Inside the floor a press collapses into the previous one — a truthful
  // outcome, without a second spawn.
  if (!claim.allowed && pending) return pending;
  lastManualRetryAt.set(gatewayId, claim.next);
  // The revival budget belongs to automatic respawns; a human press hands back
  // a full one.
  revivals.delete(gatewayId);
  const p = restartLocalGateway(gatewayId);
  manualRetryInFlight.set(gatewayId, p);
  return p;
}

function localVaults(gatewayId: string): LocalGatewayRuntime["vaults"] {
  const h = handles.get(gatewayId);
  if (!h) throw new Error(`local gateway ${gatewayId} is not running`);
  return h.vaults;
}

export async function createLocalVault(
  gatewayId: string,
  name?: string
): Promise<{ vaultId: string }> {
  return localVaults(gatewayId).create(name);
}

/** Typed-name owner ceremony. */
export async function deleteLocalVault(
  gatewayId: string,
  vaultId: string,
  name: string
): Promise<void> {
  await localVaults(gatewayId).delete(vaultId, name);
}
