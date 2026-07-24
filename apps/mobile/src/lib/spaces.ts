// Device-local registry of (gateway, vault) tuples — "Spaces".
//
// The phone is a client of one-or-more desktop gateways, each holding one-or-
// more vaults the device is enrolled in (#289). A Space is one (gateway, vault)
// tuple the phone remembers. Everything about a Space is LOCAL to this device:
// which gateways it has paired with, which vault within each it points at, and
// which one is active. Vaults themselves are never created or destroyed from
// here — that stays an admin act on the gateway host (#289). Add/switch/delete
// here mean pair-a-gateway / pick-a-tuple / forget-a-tuple, all device-side.
//
// Exactly one Space is ACTIVE at a time. The rest of the app never learns about
// the registry: the tunnel (phone-link), the replica (ReplicaProvider) and every
// gateway fetch (gateway.ts) read the "active slot" — the same single-slot keys
// the app has always used, which this module now PROJECTS from the active Space.
// So switching a Space is "rewrite the projection + restart the tunnel + re-key
// the replica"; the readers are unchanged. This module owns those keys; the
// tunnel/replica restart lives in phone-link/ReplicaProvider, which subscribe.
//
// Nothing here is a security boundary: tickets + the device secret live in
// secure-storage; vault addressing and per-device enrollment are enforced by the
// gateway. This is a preference layer that decides *which* door to knock on.

import { hydrateSecure, setSecure } from './secure-storage';
import { Store } from '../storage';

// --- The active-slot projection keys (owned here; read by phone-link/replica) ---
//
// These predate the registry. phone-link (isPaired/getDesktopName/tunnel) and
// ReplicaProvider (replica identity) read them as "the active connection"; the
// registry now writes them from whichever Space is active. Kept as the exact
// same key strings so an already-paired install keeps its tunnel + replica DB.
export const LINK_TICKET_KEY = 'phoneLink.ticket'; // secure
export const LINK_DESKTOP_NAME_KEY = 'phoneLink.desktopName';
export const LINK_DEVICE_ID_KEY = 'phoneLink.deviceId';
export const LINK_SECRET_KEY = 'phoneLink.secretKey'; // secure, device-wide (one EndpointId, many desktops)
export const LAST_GATEWAY = 'replica.lastGateway'; // replica DB namespace — must match ReplicaProvider
export const LAST_VAULT = 'replica.lastVault';
export const LAST_BASE = 'replica.lastBase';

// --- Registry storage keys (new) ---
const REGISTRY_KEY = 'spaces.registry'; // Space[] (no secrets)
const ACTIVE_ID_KEY = 'spaces.activeId'; // string
const ticketKeyFor = (id: string): string => `spaces.ticket.${id}`; // secure, per Space

/**
 * One (gateway, vault) tuple the phone remembers. Presentation
 * (`vaultName`/`color`/`icon`) is cached from `listVaults()` so an inactive
 * Space — one on a gateway we're not currently tunnelled to — still renders a
 * real label instead of a bare id. `ticket` is NOT stored here; it lives in
 * secure-storage under `ticketKeyFor(id)` (empty for a manual-URL dev Space,
 * which authenticates with a token, not a pairing ticket).
 */
export interface Space {
  /** Stable, minted once. Not derived from vault id, so a vault can be filled in later. */
  id: string;
  /** Replica DB namespace for this gateway — the value ReplicaProvider keys on. */
  gatewayId: string;
  desktopName: string;
  deviceId: string;
  /** '' while a freshly-paired gateway's enrolled vault is still resolving. */
  vaultId: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}

/** Fields a caller supplies to record/refresh a Space (ticket kept out of the row). */
export interface SpaceInput {
  gatewayId: string;
  desktopName: string;
  deviceId: string;
  vaultId: string;
  /** Pairing ticket for this gateway; '' for a manual-URL dev Space. */
  ticket: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}

// --- In-memory state (sync after hydrateSpaces, like Store/profile) ---
let registry: Space[] = [];
let activeId = '';
let hydrated = false;
// The in-flight hydration promise, so concurrent boot callers (ReplicaProvider,
// phone-link) share ONE run — the migration below is a read-modify-write that
// would duplicate the migrated Space if two cold-boot calls raced it.
let hydrating: Promise<void> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  Store.set<Space[]>(REGISTRY_KEY, registry);
  Store.set<string>(ACTIVE_ID_KEY, activeId);
}

/** Content identity of a tuple — two Spaces are "the same" iff this matches. */
function sameTuple(
  a: Pick<Space, 'gatewayId' | 'vaultId'>,
  gatewayId: string,
  vaultId: string,
): boolean {
  return a.gatewayId === gatewayId && a.vaultId === vaultId;
}

// A minted, stable id. Not content-derived, so a provisional Space (vault still
// resolving) keeps its id — and its ticket key — once the vault fills in.
function mintId(): string {
  return `sp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Copy the active Space into the single-slot keys the tunnel + replica read.
 * Async because a not-yet-hydrated Space's ticket must come off secure-storage
 * first. `LAST_BASE` is deliberately untouched — the tunnel port/base is a live,
 * per-process value resolved by phone-link, not a per-Space fact.
 */
async function projectActiveSlot(space: Space): Promise<void> {
  const ticket = await hydrateSecure(ticketKeyFor(space.id), '');
  await setSecure(LINK_TICKET_KEY, ticket);
  Store.set<string>(LINK_DESKTOP_NAME_KEY, space.desktopName);
  Store.set<string>(LINK_DEVICE_ID_KEY, space.deviceId);
  Store.set<string>(LAST_GATEWAY, space.gatewayId);
  Store.set<string>(LAST_VAULT, space.vaultId);
}

/** Clear the active slot when no Space is active (e.g. the last one is forgotten). */
async function clearActiveSlot(): Promise<void> {
  await setSecure(LINK_TICKET_KEY, '');
  Store.set<string>(LINK_DESKTOP_NAME_KEY, '');
  Store.set<string>(LINK_DEVICE_ID_KEY, '');
  Store.set<string>(LAST_VAULT, '');
  // LAST_GATEWAY/LAST_BASE left as-is: harmless stale hints, overwritten on next activate.
}

/**
 * One-time fold of a pre-registry install into a single Space, so an
 * already-paired (or manual-URL) user keeps working across the upgrade with no
 * re-pair. Runs only when the registry is empty. `gatewayId` MUST be the exact
 * `LAST_GATEWAY` value the replica already keyed on, or the migrated Space would
 * re-key to a fresh, empty replica DB.
 */
async function migrateLegacySlot(): Promise<void> {
  const [ticket, desktopName, deviceId, gatewayId, vaultId] = await Promise.all([
    hydrateSecure(LINK_TICKET_KEY, ''),
    Store.hydrate<string>(LINK_DESKTOP_NAME_KEY, ''),
    Store.hydrate<string>(LINK_DEVICE_ID_KEY, ''),
    Store.hydrate<string>(LAST_GATEWAY, ''),
    Store.hydrate<string>(LAST_VAULT, ''),
  ]);
  // Nothing to carry forward: no pairing ticket AND no resolved vault.
  if (!ticket && !vaultId) return;
  const gw = gatewayId || desktopName || 'desktop';
  const space: Space = {
    id: mintId(),
    gatewayId: gw,
    desktopName,
    deviceId,
    vaultId,
  };
  registry = [space];
  activeId = space.id;
  if (ticket) await setSecure(ticketKeyFor(space.id), ticket);
  persist();
}

/** Pull the registry into memory + fold any legacy slot. Idempotent; call once at boot. */
export async function hydrateSpaces(): Promise<void> {
  if (hydrated) return;
  // Coalesce concurrent callers onto a single run (see `hydrating` above).
  if (!hydrating) hydrating = doHydrate();
  return hydrating;
}

async function doHydrate(): Promise<void> {
  registry = await Store.hydrate<Space[]>(REGISTRY_KEY, []);
  activeId = await Store.hydrate<string>(ACTIVE_ID_KEY, '');
  if (registry.length === 0) await migrateLegacySlot();
  // Repair a dangling active pointer (e.g. its Space was removed out from under it).
  if (activeId && !registry.some((s) => s.id === activeId)) {
    activeId = registry[0]?.id ?? '';
    persist();
  }
  // Re-project so the single-slot keys always match the active Space on boot,
  // even if a prior session left them inconsistent. Cheap; runs once.
  const active = getActiveSpace();
  if (active) await projectActiveSlot(active);
  hydrated = true;
}

export function listSpaces(): Space[] {
  return registry;
}

export function getActiveSpace(): Space | undefined {
  return registry.find((s) => s.id === activeId);
}

/**
 * The vault id every gateway request should address. '' when no Space is active
 * (manual-URL dev with nothing picked yet) — callers then send no vault header
 * and let the gateway pick the device's implied vault, exactly as before.
 */
export function getActiveVaultId(): string {
  return getActiveSpace()?.vaultId ?? '';
}

/** Subscribe to any registry change (add/switch/forget/vault-resolved). Returns an unsubscribe. */
export function subscribeSpaces(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Record a tuple and make it active. Upserts by (gateway, vault) content so
 * re-adding the same tuple refreshes it in place rather than duplicating. The
 * ticket is written to secure-storage; the row (minus ticket) to the registry.
 * Does NOT restart the tunnel or replica — the caller (phone-link) orchestrates
 * that after this resolves, and subscribers react to the emit.
 */
export async function addSpace(input: SpaceInput): Promise<Space> {
  await hydrateSpaces();
  const existing = registry.find((s) => sameTuple(s, input.gatewayId, input.vaultId));
  const space: Space = {
    id: existing?.id ?? mintId(),
    gatewayId: input.gatewayId,
    desktopName: input.desktopName,
    deviceId: input.deviceId,
    vaultId: input.vaultId,
    vaultName: input.vaultName ?? existing?.vaultName,
    color: input.color ?? existing?.color,
    icon: input.icon ?? existing?.icon,
  };
  registry = existing ? registry.map((s) => (s.id === space.id ? space : s)) : [...registry, space];
  activeId = space.id;
  if (input.ticket) await setSecure(ticketKeyFor(space.id), input.ticket);
  await projectActiveSlot(space);
  persist();
  emit();
  return space;
}

/**
 * Add a vault the ACTIVE gateway already exposes as its own Space, and make it
 * active. Reuses the active gateway's identity + pairing ticket (a device is
 * enrolled once per gateway; the ticket is per-gateway, shared across its
 * vaults), so switching to the new Space keeps the same tunnel — only the vault
 * header + replica key change. When there is no active Space (manual-URL dev),
 * it records a ticket-less Space under a 'manual' gateway.
 */
export async function addActiveGatewayVault(vault: {
  vaultId: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}): Promise<Space> {
  await hydrateSpaces();
  const active = getActiveSpace();
  const ticket = await hydrateSecure(LINK_TICKET_KEY, '');
  return addSpace({
    gatewayId: active?.gatewayId ?? 'manual',
    desktopName: active?.desktopName ?? '',
    deviceId: active?.deviceId ?? '',
    vaultId: vault.vaultId,
    ticket,
    vaultName: vault.vaultName,
    color: vault.color,
    icon: vault.icon,
  });
}

/**
 * Make an existing Space active and project it into the slot. Returns the Space,
 * or undefined if the id is unknown. Like addSpace it does not touch the tunnel/
 * replica — phone-link's switchSpace wraps this to restart them when needed.
 */
export async function setActiveSpace(id: string): Promise<Space | undefined> {
  await hydrateSpaces();
  const space = registry.find((s) => s.id === id);
  if (!space) return undefined;
  activeId = id;
  await projectActiveSlot(space);
  persist();
  emit();
  return space;
}

/**
 * Forget a tuple on THIS device — the vault stays on the gateway. Deletes its
 * ticket and row; if it was active, falls back to another Space (or none). When
 * the forgotten Space is the last one for its gateway, its pairing ticket is
 * gone, so the gateway is effectively un-paired here too.
 */
export async function removeSpace(id: string): Promise<void> {
  await hydrateSpaces();
  const wasActive = activeId === id;
  registry = registry.filter((s) => s.id !== id);
  await setSecure(ticketKeyFor(id), '');
  if (wasActive) {
    const next = registry[0];
    if (next) {
      activeId = next.id;
      await projectActiveSlot(next);
    } else {
      activeId = '';
      await clearActiveSlot();
    }
  }
  persist();
  emit();
}

/**
 * Reconcile the active Space's (gatewayId, vaultId) with what the replica
 * actually opened. ReplicaProvider owns the replica identity, so after it
 * resolves a freshly-paired gateway (which starts here with a best-guess
 * gatewayId and an empty vaultId) it calls this with the authoritative values.
 * No-op when unchanged. Re-projects the slot so LAST_GATEWAY/LAST_VAULT match,
 * and drops any older duplicate the completed tuple now collides with, keeping
 * the list one-row-per-tuple.
 */
export async function noteActiveIdentity(identity: {
  gatewayId: string;
  vaultId: string;
}): Promise<void> {
  await hydrateSpaces();
  const active = getActiveSpace();
  if (!active) return;
  if (active.gatewayId === identity.gatewayId && active.vaultId === identity.vaultId) return;
  const duplicate = registry.find(
    (s) => s.id !== active.id && sameTuple(s, identity.gatewayId, identity.vaultId),
  );
  const next: Space = { ...active, gatewayId: identity.gatewayId, vaultId: identity.vaultId };
  registry = registry
    .filter((s) => s.id !== duplicate?.id)
    .map((s) => (s.id === active.id ? next : s));
  await projectActiveSlot(next);
  persist();
  emit();
}

/**
 * Refresh the active Space's cached presentation from a `listVaults()` row, so
 * the switcher shows the vault's real name/colour/icon. No-op when nothing
 * changed. Only ever updates the active Space (the only vault we can currently
 * read metadata for).
 */
export async function noteActiveVaultMeta(meta: {
  vaultName?: string;
  color?: string;
  icon?: string;
}): Promise<void> {
  await hydrateSpaces();
  const active = getActiveSpace();
  if (!active) return;
  const next: Space = {
    ...active,
    vaultName: meta.vaultName ?? active.vaultName,
    color: meta.color ?? active.color,
    icon: meta.icon ?? active.icon,
  };
  if (
    next.vaultName === active.vaultName &&
    next.color === active.color &&
    next.icon === active.icon
  ) {
    return;
  }
  registry = registry.map((s) => (s.id === active.id ? next : s));
  persist();
  emit();
}
