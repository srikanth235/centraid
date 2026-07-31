// Device-local registry of (gateway, vault) tuples — "Vaults".
//
// The phone is a client of one-or-more desktop gateways, each holding one-or-
// more vaults the device is enrolled in (#289). A VaultLink is one (gateway, vault)
// tuple the phone remembers. Everything about a VaultLink is LOCAL to this device:
// which gateways it has paired with, which vault within each it points at, and
// which one is active. Vaults themselves are never created or destroyed from
// here — that stays an admin act on the gateway host (#289). Add/switch/delete
// here mean pair-a-gateway / pick-a-tuple / forget-a-tuple, all device-side.
//
// Exactly one VaultLink is ACTIVE at a time. The rest of the app never learns about
// the registry: the tunnel (phone-link), the replica (ReplicaProvider) and every
// gateway fetch (gateway.ts) read the "active slot" — the same single-slot keys
// the app has always used, which this module now PROJECTS from the active VaultLink.
// So switching a VaultLink is "rewrite the projection + restart the tunnel + re-key
// the replica"; the readers are unchanged. This module owns those keys; the
// tunnel/replica restart lives in phone-link/ReplicaProvider, which subscribe.
//
// Nothing here is a security boundary: refreshable endpoint hints + the device
// secret live in secure storage; durable identity is the gateway EndpointId in
// each row. VaultLink addressing and enrollment are enforced by the gateway.

import { Store } from "../storage";
import { hydrateSecure, setSecure } from "./secure-storage";

// --- The active-slot projection keys (owned here; read by phone-link/replica) ---
//
// These predate the registry. phone-link (isPaired/getDesktopName/tunnel) and
// ReplicaProvider (replica identity) read them as "the active connection"; the
// registry now writes them from whichever VaultLink is active. Kept as the exact
// same key strings so an already-paired install keeps its tunnel + replica DB.
// Persisted key names retain "ticket" for migration compatibility, but their
// value is only an EndpointTicket dial hint. The one-time pairing capabilities
// (`t` + `s`) are never stored.
export const LINK_ENDPOINT_HINT_KEY = "phoneLink.ticket"; // secure
export const LINK_DESKTOP_NAME_KEY = "phoneLink.desktopName";
export const LINK_DEVICE_ID_KEY = "phoneLink.deviceId";
export const LINK_SECRET_KEY = "phoneLink.secretKey"; // secure, device-wide (one EndpointId, many desktops)
export const LAST_GATEWAY = "replica.lastGateway"; // replica DB namespace — must match ReplicaProvider
export const LAST_VAULT = "replica.lastVault";
export const LAST_BASE = "replica.lastBase";

// --- Registry storage keys (new) ---
const REGISTRY_KEY = "vaults.registry"; // VaultLink[] (no secrets)
const ACTIVE_ID_KEY = "vaults.activeId"; // string
const endpointHintKeyFor = (id: string): string => `vaults.ticket.${id}`; // secure, per VaultLink

/**
 * One (gateway, vault) tuple the phone remembers. Presentation
 * (`vaultName`/`color`/`icon`) is cached from `listVaults()` so an inactive
 * VaultLink — one on a gateway we're not currently tunnelled to — still renders a
 * real label instead of a bare id. `ticket` is NOT stored here; it lives in
 * secure-storage under `endpointHintKeyFor(id)` (empty for a manual-URL dev
 * VaultLink). It is refreshable address cache, never the gateway's identity.
 */
export interface VaultLink {
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

/** Fields a caller supplies to record/refresh a VaultLink (dial hint kept out of the row). */
export interface VaultLinkInput {
  gatewayId: string;
  desktopName: string;
  deviceId: string;
  vaultId: string;
  /** Refreshable EndpointTicket; '' for a manual-URL dev VaultLink. */
  endpointHint: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}

// --- In-memory state (sync after hydrateVaultLinks, like Store/profile) ---
let registry: VaultLink[] = [];
let activeId = "";
let hydrated = false;
// The in-flight hydration promise, so concurrent boot callers (ReplicaProvider,
// phone-link) share ONE run — the migration below is a read-modify-write that
// would duplicate the migrated VaultLink if two cold-boot calls raced it.
let hydrating: Promise<void> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  Store.set<VaultLink[]>(REGISTRY_KEY, registry);
  Store.set<string>(ACTIVE_ID_KEY, activeId);
}

/** Content identity of a tuple — two Vaults are "the same" iff this matches. */
function sameTuple(
  a: Pick<VaultLink, "gatewayId" | "vaultId">,
  gatewayId: string,
  vaultId: string
): boolean {
  return a.gatewayId === gatewayId && a.vaultId === vaultId;
}

// A minted, stable id. Not content-derived, so a provisional VaultLink (vault still
// resolving) keeps its id — and its ticket key — once the vault fills in.
function mintId(): string {
  return `sp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/**
 * Copy the active VaultLink into the single-slot keys the tunnel + replica read.
 * Async because a not-yet-hydrated VaultLink's endpoint hint must come off secure-storage
 * first. `LAST_BASE` is deliberately untouched — the tunnel port/base is a live,
 * per-process value resolved by phone-link, not a per-vault fact.
 */
async function projectActiveSlot(vault: VaultLink): Promise<void> {
  const endpointHint = await hydrateSecure(endpointHintKeyFor(vault.id), "");
  await setSecure(LINK_ENDPOINT_HINT_KEY, endpointHint);
  Store.set<string>(LINK_DESKTOP_NAME_KEY, vault.desktopName);
  Store.set<string>(LINK_DEVICE_ID_KEY, vault.deviceId);
  Store.set<string>(LAST_GATEWAY, vault.gatewayId);
  Store.set<string>(LAST_VAULT, vault.vaultId);
}

/** Clear the active slot when no VaultLink is active (e.g. the last one is forgotten). */
async function clearActiveSlot(): Promise<void> {
  await setSecure(LINK_ENDPOINT_HINT_KEY, "");
  Store.set<string>(LINK_DESKTOP_NAME_KEY, "");
  Store.set<string>(LINK_DEVICE_ID_KEY, "");
  Store.set<string>(LAST_VAULT, "");
  // LAST_GATEWAY/LAST_BASE left as-is: harmless stale hints, overwritten on next activate.
}

/**
 * One-time fold of a pre-registry install into a single VaultLink, so an
 * already-paired (or manual-URL) user keeps working across the upgrade with no
 * re-pair. Runs only when the registry is empty. `gatewayId` MUST be the exact
 * `LAST_GATEWAY` value the replica already keyed on, or the migrated VaultLink would
 * re-key to a fresh, empty replica DB.
 */
async function migrateLegacySlot(): Promise<void> {
  const [endpointHint, desktopName, deviceId, gatewayId, vaultId] =
    await Promise.all([
      hydrateSecure(LINK_ENDPOINT_HINT_KEY, ""),
      Store.hydrate<string>(LINK_DESKTOP_NAME_KEY, ""),
      Store.hydrate<string>(LINK_DEVICE_ID_KEY, ""),
      Store.hydrate<string>(LAST_GATEWAY, ""),
      Store.hydrate<string>(LAST_VAULT, ""),
    ]);
  // Nothing to carry forward: no endpoint hint AND no resolved vault.
  if (!endpointHint && !vaultId) return;
  const gw = gatewayId || desktopName || "desktop";
  const vault: VaultLink = {
    id: mintId(),
    gatewayId: gw,
    desktopName,
    deviceId,
    vaultId,
  };
  registry = [vault];
  activeId = vault.id;
  if (endpointHint) await setSecure(endpointHintKeyFor(vault.id), endpointHint);
  persist();
}

/** Pull the registry into memory + fold any legacy slot. Idempotent; call once at boot. */
export async function hydrateVaultLinks(): Promise<void> {
  if (hydrated) return;
  // Coalesce concurrent callers onto a single run (see `hydrating` above).
  if (!hydrating) hydrating = doHydrate();
  return hydrating;
}

async function doHydrate(): Promise<void> {
  registry = await Store.hydrate<VaultLink[]>(REGISTRY_KEY, []);
  activeId = await Store.hydrate<string>(ACTIVE_ID_KEY, "");
  if (registry.length === 0) await migrateLegacySlot();
  // Repair a dangling active pointer (e.g. its VaultLink was removed out from under it).
  if (activeId && !registry.some((s) => s.id === activeId)) {
    activeId = registry[0]?.id ?? "";
    persist();
  }
  // Re-project so the single-slot keys always match the active VaultLink on boot,
  // even if a prior session left them inconsistent. Cheap; runs once.
  const active = getActiveVaultLink();
  if (active) await projectActiveSlot(active);
  hydrated = true;
}

export function listVaultLinks(): VaultLink[] {
  return registry;
}

export function getActiveVaultLink(): VaultLink | undefined {
  return registry.find((s) => s.id === activeId);
}

/**
 * The vault id every gateway request should address. '' when no VaultLink is active
 * (manual-URL dev with nothing picked yet) — callers then send no vault header
 * and let the gateway pick the device's implied vault, exactly as before.
 */
export function getActiveVaultId(): string {
  return getActiveVaultLink()?.vaultId ?? "";
}

/** Subscribe to any registry change (add/switch/forget/vault-resolved). Returns an unsubscribe. */
export function subscribeVaultLinks(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Record a tuple and make it active. Upserts by (gateway, vault) content so
 * re-adding the same tuple refreshes it in place rather than duplicating. The
 * endpoint hint is written to secure-storage; the row itself contains only
 * durable identity and presentation.
 * Does NOT restart the tunnel or replica — the caller (phone-link) orchestrates
 * that after this resolves, and subscribers react to the emit.
 */
export async function addVaultLink(input: VaultLinkInput): Promise<VaultLink> {
  await hydrateVaultLinks();
  const existing = registry.find((s) =>
    sameTuple(s, input.gatewayId, input.vaultId)
  );
  const vault: VaultLink = {
    id: existing?.id ?? mintId(),
    gatewayId: input.gatewayId,
    desktopName: input.desktopName,
    deviceId: input.deviceId,
    vaultId: input.vaultId,
    vaultName: input.vaultName ?? existing?.vaultName,
    color: input.color ?? existing?.color,
    icon: input.icon ?? existing?.icon,
  };
  registry = existing
    ? registry.map((s) => (s.id === vault.id ? vault : s))
    : [...registry, vault];
  activeId = vault.id;
  if (input.endpointHint) {
    await setSecure(endpointHintKeyFor(vault.id), input.endpointHint);
  }
  await projectActiveSlot(vault);
  persist();
  emit();
  return vault;
}

/**
 * Add a vault the ACTIVE gateway already exposes as its own VaultLink, and make it
 * active. Reuses the active gateway's identity + refreshable EndpointTicket,
 * so switching to the new VaultLink keeps the same tunnel — only the vault
 * header + replica key change. When there is no active VaultLink (manual-URL dev),
 * it records a ticket-less VaultLink under a 'manual' gateway.
 */
export async function addActiveGatewayVault(vault: {
  vaultId: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}): Promise<VaultLink> {
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  const endpointHint = await hydrateSecure(LINK_ENDPOINT_HINT_KEY, "");
  return addVaultLink({
    gatewayId: active?.gatewayId ?? "manual",
    desktopName: active?.desktopName ?? "",
    deviceId: active?.deviceId ?? "",
    vaultId: vault.vaultId,
    endpointHint,
    vaultName: vault.vaultName,
    color: vault.color,
    icon: vault.icon,
  });
}

/**
 * Make an existing VaultLink active and project it into the slot. Returns the VaultLink,
 * or undefined if the id is unknown. Like addVaultLink it does not touch the tunnel/
 * replica — phone-link's switchVaultLink wraps this to restart them when needed.
 */
export async function setActiveVaultLink(
  id: string
): Promise<VaultLink | undefined> {
  await hydrateVaultLinks();
  const vault = registry.find((s) => s.id === id);
  if (!vault) return undefined;
  activeId = id;
  await projectActiveSlot(vault);
  persist();
  emit();
  return vault;
}

/**
 * Forget a tuple on THIS device — the vault stays on the gateway. Deletes its
 * endpoint hint and row; if it was active, falls back to another VaultLink (or none).
 */
export async function removeVaultLink(id: string): Promise<void> {
  await hydrateVaultLinks();
  const wasActive = activeId === id;
  registry = registry.filter((s) => s.id !== id);
  await setSecure(endpointHintKeyFor(id), "");
  if (wasActive) {
    const next = registry[0];
    if (next) {
      activeId = next.id;
      await projectActiveSlot(next);
    } else {
      activeId = "";
      await clearActiveSlot();
    }
  }
  persist();
  emit();
}

/**
 * Reconcile the active VaultLink's (gatewayId, vaultId) with what the replica
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
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  if (!active) return;
  if (
    active.gatewayId === identity.gatewayId &&
    active.vaultId === identity.vaultId
  )
    return;
  const duplicate = registry.find(
    (s) =>
      s.id !== active.id && sameTuple(s, identity.gatewayId, identity.vaultId)
  );
  const next: VaultLink = {
    ...active,
    gatewayId: identity.gatewayId,
    vaultId: identity.vaultId,
  };
  registry = registry
    .filter((s) => s.id !== duplicate?.id)
    .map((s) => (s.id === active.id ? next : s));
  await projectActiveSlot(next);
  persist();
  emit();
}

/**
 * Refresh the active VaultLink's cached presentation from a `listVaults()` row, so
 * the switcher shows the vault's real name/colour/icon. No-op when nothing
 * changed. Only ever updates the active VaultLink (the only vault we can currently
 * read metadata for).
 */
export async function noteActiveVaultMeta(meta: {
  vaultName?: string;
  color?: string;
  icon?: string;
}): Promise<void> {
  await hydrateVaultLinks();
  const active = getActiveVaultLink();
  if (!active) return;
  const next: VaultLink = {
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
