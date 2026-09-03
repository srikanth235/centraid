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
 * Electron local-gateway lifecycle (#351/#468): a detached child outliving the
 * UI (H1–H4). Quit deliberately does NOT kill detached children.
 */
export interface LocalGatewayRuntime {
  url: string;
  token: string;
  mode: "embedded" | "detached";
  owned?: boolean;
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
/** Epoch ms before which `ensureLocalGateway` refuses an attempt. */
const nextAttemptAt = new Map<string, number>();
/** Set at quit: an auto-retry must not resurrect a closing gateway. */
let disposed = false;

export function markLocalGatewaysDisposed(): void {
  disposed = true;
}

export function getLocalGatewaySupervisorState(
  gatewayId: string
): SupervisorState {
  return supervisor.get(gatewayId) ?? initialSupervisorState();
}

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

/*
 * DYNAMIC, and that is the point (#883 C5). `embedded-gateway.js` is the only
 * main-process module needing the `@centraid/server` BARREL — ~900 modules,
 * ~770 ms cold — and no production launch takes this branch. A static import
 * would put all of that on the path to the first window.
 */
async function startEmbedded(gatewayId: string): Promise<LocalGatewayRuntime> {
  const { startDesktopEmbeddedGateway } = await import("./embedded-gateway.js");
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
  // Respawns an owned daemon from an older build; stop awaits real exit.
  const detached = await ensureDetachedGateway({
    dataDir,
    ownerId,
    replaceOwnedIfStale: true,
  });
  // No-op on detached handles (the child owns its health registry).
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
  // No liveness check: reviveLocalGatewayIfDead owns retry.
  const ready = handles.get(gatewayId);
  if (ready) return ready;
  const inFlight = starting.get(gatewayId);
  if (inFlight) return inFlight;

  // Fail fast, never re-spawn per caller (#351/H7); restartLocalGateway
  // clears both maps.
  const sup = supervisor.get(gatewayId);
  if (sup?.loopBroken) {
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
          ensureLocalGateway(gatewayId).catch(() => {});
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
 * For an owned daemon that DIED after start — the supervisor sees start
 * failures only. Narrow trigger: OWNED detached (H3), pid really GONE (a
 * wedged daemon still holds gateway.db), within the claimRevival budget.
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

/** Never rejects; resolves whether a revival started. */
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
    process.stdout.write(
      `[local-gateway] respawn of "${gatewayId}" failed: ${error instanceof Error ? error.message : String(error)}\n`
    );
  });
  return true;
}

/** Idempotent; foreign detached handles are left alone (H3). */
export async function shutdownLocalGateway(gatewayId: string): Promise<void> {
  const h = handles.get(gatewayId);
  if (!h) return;
  handles.delete(gatewayId);
  await h.close().catch(() => undefined);
}

/** Detached skipped by default (H1); `includeDetached` for lifecycle owners. */
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

/** Refuses foreign detached gateways (H3); clears supervision state. */
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
 * "Try again" from the startup error screen: clearing the automatic budgets is
 * the point. claimManualRetry's floor survives — one attempt per press.
 */
const lastManualRetryAt = new Map<string, number>();
const manualRetryInFlight = new Map<string, Promise<void>>();

/** Rejects with the start failure so the caller can report why. */
export async function retryLocalGatewayStart(gatewayId: string): Promise<void> {
  const claim = claimManualRetry(lastManualRetryAt.get(gatewayId), Date.now());
  const pending = manualRetryInFlight.get(gatewayId);
  // Inside the floor a press joins the previous one.
  if (!claim.allowed && pending) return pending;
  lastManualRetryAt.set(gatewayId, claim.next);
  // A human press restores the full revival budget.
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
