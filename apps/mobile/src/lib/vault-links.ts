// Device-local registry of (gateway, vault) tuples — "Vaults" (#289).
//
// Everything here is LOCAL to this device. Vaults are never created or
// destroyed from the phone; add/switch/delete mean pair-a-gateway /
// pick-a-tuple / forget-a-tuple.
//
// Exactly one VaultLink is ACTIVE, and the rest of the app never learns about
// the registry: phone-link, ReplicaProvider and gateway.ts all read the
// single-slot keys this module PROJECTS from the active link. Switching is
// "rewrite the projection, restart the tunnel, re-key the replica" — the
// readers are unchanged, and the restart lives in the subscribers.
//
// NOT a security boundary: endpoint hints are refreshable address cache, and
// addressing and enrollment are enforced by the gateway.

import { Store } from "../storage";
import { hydrateSecure, setSecure } from "./secure-storage";

// --- The active-slot projection keys (owned here; read by phone-link/replica) ---
//
// These key STRINGS are frozen: an already-paired install keeps its tunnel and
// replica DB only if they never change. "ticket" in a name is migration
// compatibility — the value is only an EndpointTicket dial hint, and the
// one-time pairing capabilities (`t` + `s`) are NEVER stored.
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
 * Presentation is cached from `listVaults()` so an inactive link still renders
 * a real label instead of a bare id. The endpoint hint is NEVER stored on the
 * row — it lives in secure storage under `endpointHintKeyFor(id)`.
 */
export interface VaultLink {
  /** Minted once, NOT derived from the vault id, so the vault can fill in
   *  later without the link (or its hint key) changing. */
  id: string;
  /** Replica DB namespace — the value ReplicaProvider keys on. */
  gatewayId: string;
  desktopName: string;
  deviceId: string;
  /** '' while a freshly-paired gateway's enrolled vault is still resolving. */
  vaultId: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}

/** The dial hint is passed here but kept out of the stored row. */
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
// So concurrent boot callers share ONE hydration run.
let hydrating: Promise<void> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  Store.set<VaultLink[]>(REGISTRY_KEY, registry);
  Store.set<string>(ACTIVE_ID_KEY, activeId);
}

/** Content identity: two links are "the same" iff this matches. */
function sameTuple(
  a: Pick<VaultLink, "gatewayId" | "vaultId">,
  gatewayId: string,
  vaultId: string
): boolean {
  return a.gatewayId === gatewayId && a.vaultId === vaultId;
}

// Never content-derived: a provisional link keeps its id, and its hint key,
// once the vault fills in.
function mintId(): string {
  return `sp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** `LAST_BASE` is deliberately untouched: the tunnel port/base is a live,
 *  per-process value phone-link resolves, not a per-vault fact. */
async function projectActiveSlot(vault: VaultLink): Promise<void> {
  const endpointHint = await hydrateSecure(endpointHintKeyFor(vault.id), "");
  await setSecure(LINK_ENDPOINT_HINT_KEY, endpointHint);
  Store.set<string>(LINK_DESKTOP_NAME_KEY, vault.desktopName);
  Store.set<string>(LINK_DEVICE_ID_KEY, vault.deviceId);
  Store.set<string>(LAST_GATEWAY, vault.gatewayId);
  Store.set<string>(LAST_VAULT, vault.vaultId);
}

async function clearActiveSlot(): Promise<void> {
  await setSecure(LINK_ENDPOINT_HINT_KEY, "");
  Store.set<string>(LINK_DESKTOP_NAME_KEY, "");
  Store.set<string>(LINK_DEVICE_ID_KEY, "");
  Store.set<string>(LAST_VAULT, "");
  // LAST_GATEWAY/LAST_BASE left as-is: harmless stale hints, overwritten on
  // the next activate.
}

/** Idempotent; call once at boot. */
export async function hydrateVaultLinks(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) hydrating = doHydrate();
  return hydrating;
}

async function doHydrate(): Promise<void> {
  registry = await Store.hydrate<VaultLink[]>(REGISTRY_KEY, []);
  activeId = await Store.hydrate<string>(ACTIVE_ID_KEY, "");
  // Repair a dangling active pointer.
  if (activeId && !registry.some((s) => s.id === activeId)) {
    activeId = registry[0]?.id ?? "";
    persist();
  }
  // Re-project so the single-slot keys match the active link on boot even if a
  // prior session left them inconsistent.
  const active = getActiveVaultLink();
  if (active) await projectActiveSlot(active);
  hydrated = true;

  // MUST emit: `getActiveVaultLink` reads in-memory state that only exists
  // after this hydrate, so a screen mounting first sees an empty registry and
  // otherwise waits on a change that never comes.
  emit();
}

export function listVaultLinks(): VaultLink[] {
  return registry;
}

export function getActiveVaultLink(): VaultLink | undefined {
  return registry.find((s) => s.id === activeId);
}

/** '' when no link is active — callers then send no vault header and let the
 *  gateway pick the device's implied vault. */
export function getActiveVaultId(): string {
  return getActiveVaultLink()?.vaultId ?? "";
}

/** Returns an unsubscribe. */
export function subscribeVaultLinks(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/**
 * Upserts by (gateway, vault) content, so re-adding a tuple refreshes it in
 * place rather than duplicating.
 *
 * Does NOT restart the tunnel or replica — phone-link orchestrates that after
 * this resolves, and subscribers react to the emit.
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

/** Reuses the active gateway's identity and dial hint, so switching to the new
 *  link keeps the SAME tunnel — only the vault header and replica key change.
 *  With no active link, records a hint-less one under a 'manual' gateway. */
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

/** `undefined` if the id is unknown. Like `addVaultLink`, does not touch the
 *  tunnel or replica — `switchVaultLink` wraps this to restart them. */
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

/** Forgets a tuple on THIS device; the vault stays on the gateway. */
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
 * ReplicaProvider owns the replica identity and is AUTHORITATIVE here: a
 * freshly-paired gateway starts with a best-guess `gatewayId` and an empty
 * `vaultId`, and this reconciles them.
 *
 * Re-projects the slot so LAST_GATEWAY/LAST_VAULT match, and drops any older
 * duplicate the completed tuple now collides with — one row per tuple.
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

/** Only ever the ACTIVE link — the only vault whose metadata this device can
 *  currently read. No-op when nothing changed. */
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
