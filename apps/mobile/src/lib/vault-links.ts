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
/**
 * THE BASE BELONGS TO THE GATEWAY, NOT TO THE PHONE (#1014, P13).
 *
 * One global key held "the last base URL" across every gateway this device is
 * paired with. With two gateways the value is whichever one answered last, so
 * vault B's seat, feed and intent drain all opened against gateway A's port —
 * and the only thing standing between that and a cross-gateway apply was the
 * applier's epoch check. The key is retired in place: `lastBaseKeyFor` names
 * one per gateway, and the old value is read once as the seed for whichever
 * gateway is active when a phone first runs this build.
 */
export const LAST_BASE_LEGACY = "replica.lastBase";

/** The default a phone that has never reached this gateway starts from. */
export const DEFAULT_GATEWAY_BASE = "http://127.0.0.1";

/** Where each gateway was last reachable. One key per gateway id (P13). */
export const LastBase = {
  keyFor(gatewayId: string): string {
    return `replica.lastBase.${gatewayId}`;
  },
  /**
   * Falls back to the retired global key ONCE — a phone upgrading into this
   * build has a live value there and no per-gateway one, and losing it costs
   * a cold mount its offline base.
   */
  async hydrate(gatewayId: string): Promise<string> {
    const own = await Store.hydrate<string>(LastBase.keyFor(gatewayId), "");
    if (own) return own;
    const legacy = await Store.hydrate<string>(LAST_BASE_LEGACY, "");
    return legacy || DEFAULT_GATEWAY_BASE;
  },
  set(gatewayId: string, baseUrl: string): void {
    Store.set<string>(LastBase.keyFor(gatewayId), baseUrl);
  },
};

const REGISTRY_KEY = "vaults.registry"; // VaultLink[] — no secrets
const ACTIVE_ID_KEY = "vaults.activeId";
/**
 * REGISTRY AND ACTIVE ID, IN ONE VALUE (#1014, P20).
 *
 * `Store.set` is fire-and-forget with a swallowed failure, and the two keys
 * were written one after the other — so a kill (or one failed write) right
 * after pairing or switching left an active id naming a link the registry did
 * not have, or a registry whose new link nothing pointed at. `doHydrate`
 * repaired one of those two directions and not the other.
 *
 * One key, written once, holds both. The pair of legacy keys is still READ on
 * hydrate (a phone upgrading into this build has its links only there) and
 * still written, so a downgrade finds what it expects; the combined key is the
 * one that decides when the two disagree.
 */
const STATE_KEY = "vaults.state"; // { registry, activeId } — no secrets

interface VaultLinkState {
  registry: VaultLink[];
  activeId: string;
}
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
  // The combined value FIRST: it is the one hydrate believes, so a kill
  // between the three writes leaves a consistent pair, never a torn one.
  Store.set<VaultLinkState>(STATE_KEY, { registry, activeId });
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

/** Do not write the base — the tunnel port is live, and per GATEWAY (P13). */
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
  // LAST_GATEWAY and the per-gateway base stay: stale hints, overwritten
  // on the next activate, and the base is the GATEWAY's fact (P13).
}

export async function hydrateVaultLinks(): Promise<void> {
  if (hydrated) return;
  if (!hydrating) hydrating = doHydrate();
  return hydrating;
}

async function doHydrate(): Promise<void> {
  const [combined, legacyRegistry, legacyActiveId] = await Promise.all([
    Store.hydrate<VaultLinkState | undefined>(STATE_KEY, undefined),
    Store.hydrate<VaultLink[]>(REGISTRY_KEY, []),
    Store.hydrate<string>(ACTIVE_ID_KEY, ""),
  ]);
  registry = combined?.registry ?? legacyRegistry;
  activeId = combined?.activeId ?? legacyActiveId;
  // BOTH DIRECTIONS, NOT ONE (#1014, P20). An active id naming a link the
  // registry lost, AND a registry with links nothing points at, are the two
  // halves of the same torn write; repairing only the first left a phone with
  // vaults it had paired and no way to reach them.
  if (activeId && !registry.some((link) => link.id === activeId)) {
    activeId = registry[0]?.id ?? "";
    persist();
  } else if (!activeId && registry.length > 0) {
    activeId = registry[0]!.id;
    persist();
  } else if (combined === undefined && registry.length > 0) {
    // First run on this build: write the combined value so the next kill has
    // one key to be atomic about.
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
  // RESOLVE OR REFUSE (#1014, P14, ruling R-1014-11). This used to fall back
  // to the literal `"manual"`, which named a seat file that `noteActiveIdentity`
  // then moved out from under the member's queued writes. There is no vault to
  // add to a gateway this device cannot name.
  if (!active?.gatewayId) {
    throw new Error(
      "addActiveGatewayVault: no active gateway to add this vault to"
    );
  }
  const endpointHint = await hydrateSecure(LINK_ENDPOINT_HINT_KEY, "");
  return addVaultLink({
    gatewayId: active.gatewayId,
    desktopName: active.desktopName,
    deviceId: active.deviceId,
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
  // AN EMPTY ID MAY BE FILLED; A RESOLVED ONE IS NEVER REWRITTEN (#1014, P14).
  // Rewriting it renamed the seat file — `(gatewayId, vaultId)` is the file's
  // name — and every write queued in the old file's outbox was orphaned there.
  // A different gateway answering for this link is a new link, not a rename.
  if (active.gatewayId !== "" && active.gatewayId !== identity.gatewayId) {
    console.warn(
      `[centraid] vault-links: refusing to move ${active.vaultId} from gateway ` +
        `${active.gatewayId} to ${identity.gatewayId} — the seat file is named after it`
    );
    return;
  }
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
