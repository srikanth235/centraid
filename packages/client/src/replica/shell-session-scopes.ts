/*
 * THE SCOPE REGISTRY (#599, #922 C6).
 *
 * One session per (gateway, vault), refcounted, with a warm grace so leaving an
 * app and coming back does not pay a second open — and terminal purges that
 * survive the process that scheduled them.
 *
 * SEPARATE FROM THE SESSION because they are separate concerns that were one
 * file: the session owns ONE scope's seat and queue, and this owns WHICH scopes
 * are open and what happens when the page hides, the gateway changes, or a
 * membership is revoked. The session never reaches back into this — its one
 * dependency is the `onAuthorizationRevoked` callback the registry hands it.
 */

import { auth } from "../gateway-client-core.js";
import type { GatewayAuth } from "../gateway-client-core.js";
import { vaultStatus } from "../gateway-client-vault.js";
import { ReplicaProtocolError } from "./errors.js";
import {
  fetchReplicaForScope,
  normalizedGatewayUrl,
  replicaIdentityForGatewayAuth,
  sameIdentity,
} from "./replica-identity.js";
import type { ReplicaShellSessionOptions } from "./shell-session-types.js";
import { ReplicaShellSession } from "./shell-session.js";
import {
  prepareRememberedReplicaIdentity,
  purgeRememberedReplicaIdentities,
  purgeReplicaIdentityStorage,
} from "./storage-manifest.js";
import {
  purgeBrowserReplicaCaches,
  terminalPurgeRetryLoop,
} from "./terminal-purge.js";
import type { ReplicaIdentity } from "./types.js";

export type OpenReplicaShellSessionOptions =
  ReplicaShellSessionOptions<ReplicaShellSession>;

export async function openReplicaShellSession(
  gatewayAuth: GatewayAuth,
  options: OpenReplicaShellSessionOptions = {}
): Promise<ReplicaShellSession> {
  if (!gatewayAuth.vaultId)
    throw new ReplicaProtocolError("An addressed vault is required");
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  const rememberRequested = gatewayAuth.rememberDevice === true;
  const inventoryOptions = {
    ...(options.indexedDbFactory
      ? { indexedDbFactory: options.indexedDbFactory }
      : {}),
    ...(options.inventory ? { inventory: options.inventory } : {}),
  };
  const remember = rememberRequested
    ? await prepareRememberedReplicaIdentity(identity, inventoryOptions)
    : false;
  if (!rememberRequested) {
    await purgeRememberedReplicaIdentities(
      (item) => sameIdentity(item, identity),
      { ...inventoryOptions, purgeSelector: { kind: "identity", ...identity } }
    );
  }
  const session = new ReplicaShellSession(gatewayAuth, {
    ...options,
    fetcher: options.fetcher ?? fetchReplicaForScope(gatewayAuth),
    rememberStorage: remember,
  });
  try {
    await session.start();
  } catch (error) {
    // NEVER LEAVE THE HANDLES BEHIND (#922 E3). A failed open drops the scope
    // registry's entry, so the next lease opens a SECOND seat on the same OPFS
    // pool; the first still holds its access handles and the second cannot
    // create them. Closing here hands them back before the failure is re-raised.
    await session.close().catch(() => undefined);
    throw error;
  }
  return session;
}

/** Teardown mutates shared ownership — finish each scope before the next. */
function applyScopeTeardownsInOrder<T>(
  values: Iterable<T>,
  teardown: (value: T) => void | PromiseLike<void>
): Promise<void> {
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => teardown(value)),
    Promise.resolve()
  );
}

/** One mounted scope. Last-holder release stays warm while the page is
 *  visible; `replicaScopeDisposition` decides (#599, #922 C6). */
interface SessionEntry {
  key: string;
  identity: ReplicaIdentity;
  promise: Promise<ReplicaShellSession>;
  refs: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Release twice is a no-op. */
export interface ReplicaScopeLease {
  readonly session: ReplicaShellSession;
  release: () => void;
}

const sessions = new Map<string, SessionEntry>();
const SESSION_IDLE_GRACE_MS = 30_000;

/** The page as the scope registry sees it (#922 C6). */
export type ReplicaPageState = "visible" | "hidden" | "frozen";
let pageState: ReplicaPageState = "visible";
export function replicaPageState(): ReplicaPageState {
  return pageState;
}

/**
 * WHAT A SCOPE NOBODY IS READING DOES NEXT (#922 C6).
 *
 * `warm` is the 30-second grace (#599): leaving an app and coming back must not
 * pay a second open, so a released scope keeps its seat that long. The grace is
 * a bet that the owner is still here, and a hidden or frozen page has lost that
 * bet — the browser freezes hidden pages precisely when it wants their memory
 * back, and a seat holding OPFS access handles it is not reading is the first
 * thing that should give them up.
 *
 * A scope a screen still holds is never closed under it: the lease hands the
 * session object straight to the mounted app, so closing it would fail the
 * app's next read rather than reopen.
 */
export function replicaScopeDisposition(
  page: ReplicaPageState,
  refs: number
): "hold" | "warm" | "close" {
  if (refs > 0) return "hold";
  return page === "visible" ? "warm" : "close";
}

let addressedFallback:
  | { key: string; promise: Promise<string | undefined> }
  | undefined;
let lifecycleInstalled = false;
let lifecyclePurge = Promise.resolve();

function entryFor(gatewayAuth: GatewayAuth): SessionEntry {
  installReplicaStorageLifecycle();
  const identity = replicaIdentityForGatewayAuth(gatewayAuth);
  const key = identityKey(identity);
  const existing = sessions.get(key);
  if (existing) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
    return existing;
  }
  const promise = openReplicaShellSession(gatewayAuth, {
    onAuthorizationRevoked: revokeAndPurge,
  });
  const entry: SessionEntry = { key, identity, promise, refs: 0 };
  sessions.set(key, entry);
  promise.catch(() => {
    if (sessions.get(key) === entry) sessions.delete(key);
  });
  return entry;
}

/** Refuse a scope from another gateway rather than opening against the wrong host. */
async function gatewayAuthForIdentity(
  identity: ReplicaIdentity
): Promise<GatewayAuth> {
  const base = await auth();
  const gatewayId =
    base.gatewayId?.trim() || normalizedGatewayUrl(base.baseUrl);
  if (gatewayId !== identity.gatewayId) {
    throw new ReplicaProtocolError(
      `Scope ${identity.vaultId} belongs to a different gateway`
    );
  }
  return { ...base, vaultId: identity.vaultId };
}

function scheduleIdleClose(entry: SessionEntry): void {
  if (entry.idleTimer) return;
  const timer = setTimeout(() => {
    entry.idleTimer = undefined;
    if (entry.refs > 0 || sessions.get(entry.key) !== entry) return;
    void dropEntry(entry, "close");
  }, SESSION_IDLE_GRACE_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  entry.idleTimer = timer;
}

function reclaimScope(entry: SessionEntry): void {
  const disposition = replicaScopeDisposition(pageState, entry.refs);
  if (disposition === "hold") return;
  if (disposition === "warm") {
    scheduleIdleClose(entry);
    return;
  }
  void dropEntry(entry, "close");
}

/**
 * The page-lifecycle signals the scope registry acts on (#922 C6). `freeze` is
 * this platform's memory-pressure event: the browser fires it on a hidden page
 * whose memory it is reclaiming, and a page that is discarded after it never
 * runs again — so the handles have to go back before it returns.
 */
function installPageLifecycle(): void {
  if (typeof document === "undefined") return;
  const enter = (next: ReplicaPageState): void => {
    pageState = next;
    if (next === "visible") return;
    // Snapshot: reclaiming a scope deletes it from the map being walked.
    const open = [...sessions.values()];
    for (const entry of open) reclaimScope(entry);
  };
  document.addEventListener("visibilitychange", () => {
    enter(document.visibilityState === "hidden" ? "hidden" : "visible");
  });
  document.addEventListener("freeze", () => enter("frozen"));
  document.addEventListener("resume", () => enter("visible"));
}

async function dropEntry(
  entry: SessionEntry,
  mode: "purge" | "close"
): Promise<void> {
  if (sessions.get(entry.key) === entry) sessions.delete(entry.key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  await entry.promise
    .then(async (session) => {
      if (mode !== "purge") return session.close();
      const taken = await session.purge();
      // NEVER SILENT (#1014, P24; R-1014-12). A purge that took the member's
      // unsent work says so; the browser has no revoked-notice store to hang
      // it on, so the console is where a support session can find it.
      if (taken && taken.unsent > 0) {
        console.warn(
          `[centraid] replica: purged ${entry.identity.vaultId} with ${taken.unsent} ` +
            `unsent change(s) — ${taken.saved ? "saved to revoked-outbox JSON in OPFS" : "NOT saved"}`
        );
      }
      return undefined;
    })
    .catch(() => undefined)
    .finally(() => {
      if (mode === "purge") terminalPurgeRetryLoop.wake();
    });
}

export async function getReplicaShellSessionFor(
  identity: ReplicaIdentity
): Promise<ReplicaShellSession> {
  return entryFor(await gatewayAuthForIdentity(identity)).promise;
}

export async function acquireReplicaShellSession(
  identity: ReplicaIdentity
): Promise<ReplicaScopeLease> {
  const entry = entryFor(await gatewayAuthForIdentity(identity));
  entry.refs += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    entry.refs = Math.max(0, entry.refs - 1);
    reclaimScope(entry);
  };
  try {
    return { session: await entry.promise, release };
  } catch (error) {
    release();
    throw error;
  }
}

export async function getReplicaShellSession(): Promise<ReplicaShellSession> {
  return entryFor(await addressedGatewayAuth()).promise;
}

export async function purgeReplicaShellSession(): Promise<void> {
  await applyScopeTeardownsInOrder([...sessions.values()], (entry) =>
    dropEntry(entry, "purge")
  );
}

export async function purgeCurrentReplicaDevice(): Promise<void> {
  purgeBrowserReplicaCaches();
  forgetAllAddressedVaults();
  addressedFallback = undefined;
  // Fan across every mounted identity, not just the focused one (#599).
  const identities = new Map<string, ReplicaIdentity>(
    [...sessions.values()].map((entry) => [entry.key, entry.identity])
  );
  try {
    const gatewayAuth = await auth();
    if (gatewayAuth.vaultId) {
      const identity = replicaIdentityForGatewayAuth(gatewayAuth);
      identities.set(identityKey(identity), identity);
    }
  } catch {
    // Open sessions still carry identities and purge below.
  }
  await purgeReplicaShellSession();
  try {
    await applyScopeTeardownsInOrder(identities.values(), (identity) =>
      purgeRememberedReplicaIdentities((item) => sameIdentity(item, identity), {
        purgeSelector: { kind: "identity", ...identity },
      })
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        "Could not durably schedule remembered replica discovery"
    ) {
      throw error;
    }
    // Selector was written before deletion; a missing inventory is retried.
  } finally {
    terminalPurgeRetryLoop.wake();
  }
}

export async function closeReplicaShellSession(): Promise<void> {
  await applyScopeTeardownsInOrder([...sessions.values()], (entry) =>
    dropEntry(entry, "close")
  );
}

/**
 * Terminal events plus the page's own lifecycle (#599, #922 C6). Do not re-wire
 * `onVaultChanged` to purge — focus change must close warm, not wipe the scope
 * just left; hiding and freezing close warm too, they only skip the grace.
 */
export function installReplicaStorageLifecycle(): void {
  if (lifecycleInstalled) return;
  lifecycleInstalled = true;
  installPageLifecycle();
  terminalPurgeRetryLoop.start();
  window.CentraidApi.onGatewayChanged?.((detail) => {
    queueLifecyclePurge(() => handleGatewayChanged(detail));
  });
}

interface GatewayChangedDetail {
  activeGatewayId: string;
  gatewayId?: string;
  removedGatewayId?: string;
  purgeReplicaGatewayId?: string;
}

async function handleGatewayChanged(
  detail: GatewayChangedDetail
): Promise<void> {
  const activeGatewayId = detail.gatewayId ?? detail.activeGatewayId;
  const purgeGatewayIds = new Set<string>();
  if (detail.removedGatewayId) purgeGatewayIds.add(detail.removedGatewayId);
  if (detail.purgeReplicaGatewayId)
    purgeGatewayIds.add(detail.purgeReplicaGatewayId);
  for (const gatewayId of purgeGatewayIds) forgetAddressedVault(gatewayId);
  if (addressedFallback && purgeGatewayIds.has(addressedFallback.key))
    addressedFallback = undefined;
  // Removed gateway is terminal; lost-focus scopes close warm and keep storage.
  await applyScopeTeardownsInOrder([...sessions.values()], async (entry) => {
    if (purgeGatewayIds.has(entry.identity.gatewayId))
      await dropEntry(entry, "purge");
    else if (entry.identity.gatewayId !== activeGatewayId)
      await dropEntry(entry, "close");
  });
  await applyScopeTeardownsInOrder(purgeGatewayIds, (gatewayId) =>
    purgeRememberedReplicaIdentities(
      (identity) => identity.gatewayId === gatewayId,
      { purgeSelector: { kind: "gateway", gatewayId } }
    )
  );
}

function queueLifecyclePurge(task: () => Promise<void>): void {
  lifecyclePurge = lifecyclePurge
    .then(task, task)
    .catch(() => undefined)
    .finally(() => terminalPurgeRetryLoop.wake());
}

function forgetSession(session: ReplicaShellSession): void {
  for (const entry of sessions.values()) {
    void entry.promise.then((active) => {
      if (active === session && sessions.get(entry.key) === entry)
        sessions.delete(entry.key);
    });
  }
}

/**
 * The gateway refused this session's credentials. Drop the scope, clear the
 * browser's cached bytes for it, and purge — the session itself only reports
 * the refusal, so this whole response lives in one place.
 */
function revokeAndPurge(session: ReplicaShellSession): void {
  forgetSession(session);
  purgeBrowserReplicaCaches();
  void purgeSessionTerminal(session);
}

async function purgeSessionTerminal(
  session: ReplicaShellSession
): Promise<void> {
  try {
    await session.purge();
  } catch {
    await purgeReplicaIdentityStorage(
      replicaIdentityForGatewayAuth(session.gatewayAuth)
    ).catch(() => undefined);
  } finally {
    terminalPurgeRetryLoop.wake();
  }
}

/**
 * Replica storage is keyed by `(gatewayId, vaultId)` — do not guess
 * `listVaults()[0]`; device-token addresses the oldest enrollment (#289).
 */
export async function addressedGatewayAuth(): Promise<GatewayAuth> {
  const gatewayAuth = await auth();
  const key =
    gatewayAuth.gatewayId?.trim() || normalizedGatewayUrl(gatewayAuth.baseUrl);
  if (gatewayAuth.vaultId) {
    rememberAddressedVault(key, gatewayAuth.vaultId);
    return gatewayAuth;
  }
  let pending = addressedFallback?.key === key ? addressedFallback : undefined;
  if (!pending) {
    const promise = vaultStatus()
      .then((status) => status?.vaultId)
      .catch(() => undefined);
    pending = { key, promise };
    addressedFallback = pending;
    void promise.then((vaultId) => {
      // No vault plane — do not pin "unknown"; let the next call re-ask.
      if (vaultId === undefined && addressedFallback?.promise === promise) {
        addressedFallback = undefined;
      } else if (vaultId) rememberAddressedVault(key, vaultId);
    });
  }
  // Last-known id for this gateway, without waiting on `_vault/status` (Iroh
  // dial). Not `listVaults()[0]` — the gateway's own previous answer.
  const remembered = rememberedAddressedVault(key);
  if (remembered) return { ...gatewayAuth, vaultId: remembered };
  const vaultId = await pending.promise;
  return vaultId ? { ...gatewayAuth, vaultId } : gatewayAuth;
}

const ADDRESSED_VAULT_KEY = "centraid.v1.replica.addressedVault";

function addressedVaultStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function readAddressedVaults(): Record<string, string> {
  try {
    const raw = addressedVaultStorage()?.getItem(ADDRESSED_VAULT_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeAddressedVaults(map: Record<string, string>): void {
  try {
    const storage = addressedVaultStorage();
    if (!storage) return;
    if (Object.keys(map).length === 0) storage.removeItem(ADDRESSED_VAULT_KEY);
    else storage.setItem(ADDRESSED_VAULT_KEY, JSON.stringify(map));
  } catch {
    /* A storage denial only costs the fast path — the network ask still runs. */
  }
}

function rememberedAddressedVault(gatewayKey: string): string | undefined {
  const value = readAddressedVaults()[gatewayKey];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rememberAddressedVault(gatewayKey: string, vaultId: string): void {
  const map = readAddressedVaults();
  if (map[gatewayKey] === vaultId) return;
  map[gatewayKey] = vaultId;
  writeAddressedVaults(map);
}

function forgetAddressedVault(gatewayKey: string): void {
  const map = readAddressedVaults();
  if (!(gatewayKey in map)) return;
  delete map[gatewayKey];
  writeAddressedVaults(map);
}

function forgetAllAddressedVaults(): void {
  writeAddressedVaults({});
}

/**
 * NUL-joined: a byte no id can carry, so the key cannot collide across fields.
 * `\u0000` as an escape rather than the character itself — a literal control
 * byte in a source file is invisible in every diff that would review it.
 */
function identityKey(identity: ReplicaIdentity): string {
  return `${identity.gatewayId}\u0000${identity.vaultId}`;
}
