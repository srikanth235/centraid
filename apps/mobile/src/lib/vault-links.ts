// Device-local (gateway, vault) tuples (#289). Pair / pick / forget — never
// create or destroy vaults. One active link; readers see projected keys only.
// Not a security boundary — addressing is gateway-side.

import { Store } from "../storage";
import { hydrateSecure, setSecure } from "./secure-storage";

// Active-slot keys (owned here; read by phone-link/replica). Strings are frozen:
// renaming orphans an already-paired install. "ticket" is migration compatibility
// — value is an EndpointTicket; one-time pairing (`t` + `s`) is NEVER stored.
export const LINK_ENDPOINT_HINT_KEY = "phoneLink.ticket"; // secure
export const LINK_DESKTOP_NAME_KEY = "phoneLink.desktopName";
export const LINK_DEVICE_ID_KEY = "phoneLink.deviceId";
export const LINK_SECRET_KEY = "phoneLink.secretKey"; // secure, device-wide (one EndpointId, many desktops)
export const LAST_GATEWAY = "replica.lastGateway"; // must match ReplicaProvider
export const LAST_VAULT = "replica.lastVault";
export const LAST_BASE = "replica.lastBase";

const REGISTRY_KEY = "vaults.registry"; // VaultLink[] — no secrets
const ACTIVE_ID_KEY = "vaults.activeId";
const endpointHintKeyFor = (id: string): string => `vaults.ticket.${id}`; // secure, per VaultLink

/** Endpoint hint is NEVER on the row — secure storage via `endpointHintKeyFor`. */
export interface VaultLink {
  /** Minted once — not derived from vault id. */
  id: string;
  gatewayId: string;
  desktopName: string;
  deviceId: string;
  /** '' while a freshly-paired gateway's enrolled vault is still resolving. */
  vaultId: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}

export interface VaultLinkInput {
  gatewayId: string;
  desktopName: string;
  deviceId: string;
  vaultId: string;
  /** Refreshable EndpointTicket; '' for a manual-URL VaultLink. */
  endpointHint: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}

let registry: VaultLink[] = [];
let activeId = "";
let hydrated = false;
// Concurrent boot callers share one hydration run.
let hydrating: Promise<void> | undefined;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function persist(): void {
  Store.set<VaultLink[]>(REGISTRY_KEY, registry);
  Store.set<string>(ACTIVE_ID_KEY, activeId);
}

function sameTuple(
  a: Pick<VaultLink, "gatewayId" | "vaultId">,
  gatewayId: string,
  vaultId: string
): boolean {
  return a.gatewayId === gatewayId && a.vaultId === vaultId;
}

// Never content-derived: a provisional link keeps its id and hint key.
function mintId(): string {
  return `sp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Do not write `LAST_BASE` — tunnel port is live, not a per-vault fact. */
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
  // LAST_GATEWAY/LAST_BASE stay: stale hints, overwritten on next activate.
}

export async function hydrateVaultLinks(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) hydrating = doHydrate();
  return hydrating;
}

async function doHydrate(): Promise<void> {
  registry = await Store.hydrate<VaultLink[]>(REGISTRY_KEY, []);
  activeId = await Store.hydrate<string>(ACTIVE_ID_KEY, "");
  if (activeId && !registry.some((s) => s.id === activeId)) {
    activeId = registry[0]?.id ?? "";
    persist();
  }
  const active = getActiveVaultLink();
  if (active) await projectActiveSlot(active);
  hydrated = true;

  // MUST emit: in-memory state exists only after hydrate; a first mount
  // otherwise waits on a change that never comes.
  emit();
}

export function listVaultLinks(): VaultLink[] {
  return registry;
}

export function getActiveVaultLink(): VaultLink | undefined {
  return registry.find((s) => s.id === activeId);
}

/** '' when none active — callers send no vault header; the gateway picks. */
export function getActiveVaultId(): string {
  return getActiveVaultLink()?.vaultId ?? "";
}

export function subscribeVaultLinks(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Upsert by (gateway, vault). Does NOT restart the tunnel or replica. */
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

/** Forget the tuple on THIS device; the vault stays on the gateway. */
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

/** ReplicaProvider is authoritative after pairing; drop any older duplicate. */
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
