import { Store } from "../storage";
import { hydrateSecure, setSecure } from "./secure-storage";

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

export interface VaultLink {
  id: string;
  gatewayId: string;
  desktopName: string;
  deviceId: string;
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
  endpointHint: string;
  vaultName?: string;
  color?: string;
  icon?: string;
}

let registry: VaultLink[] = [];
let activeId = "";
let hydrated = false;
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

function mintId(): string {
  return `sp_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

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

  emit();
}

export function listVaultLinks(): VaultLink[] {
  return registry;
}

export function getActiveVaultLink(): VaultLink | undefined {
  return registry.find((s) => s.id === activeId);
}

export function getActiveVaultId(): string {
  return getActiveVaultLink()?.vaultId ?? "";
}

export function subscribeVaultLinks(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

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
