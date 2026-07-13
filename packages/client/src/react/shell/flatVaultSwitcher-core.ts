/*
 * Pure core for the flat (gateway, vault) switcher (issue #376, spec #289
 * §7). The popover used to list only the active gateway's vaults
 * (`useActiveVault.ts` against `listVaults()`); this folds EVERY registered
 * gateway's vaults into one flat, sorted list of (gateway, vault) pairs,
 * with per-pair reachability so an offline/unauthorized gateway degrades to
 * a single disabled row instead of hanging the whole popover.
 *
 * Everything here is synchronous, side-effect-free, and electron-free (the
 * same "electron-free pure core" split as `gateway-pairing-core.ts` /
 * `gateway-ops-core.ts`) — `flatVaultSwitcherRegistry.ts` wires the real
 * `listGateways` / `listGatewayVaults` IPC calls and the module-level cache
 * around it.
 */

/** Minimal shape of a gateway profile this module needs (subset of
 *  `CentraidGatewayProfile`). `transport`/`hasSsh` feed the grouped
 *  switcher's transport badge + "can this gateway create a vault from here"
 *  capability (issue #382) — both optional since older profiles predate
 *  `transport` and `hasSsh` is a brand-new field the backend half of #382
 *  adds to `listGateways`'s DTO. */
export interface FlatSwitcherGateway {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: 'local' | 'remote';
  transport?: 'local' | 'iroh' | 'direct';
  hasSsh?: boolean;
}

/** One vault of a gateway (subset of `CentraidGatewayVaultEntry`). */
export interface FlatSwitcherVault {
  vaultId: string;
  name: string;
  color?: string;
  icon?: string;
  blurb?: string;
}

/** Stable reasons a gateway's vault list didn't come back — mirrors
 *  `CentraidListGatewayVaultsResult`'s error union, plus `'loading'` for a
 *  fetch that hasn't settled yet (never `'auth_failed'`/`'bad_response'`
 *  until a real fetch resolves that way). */
export type FlatSwitcherGatewayStatus = 'loading' | 'unreachable' | 'auth_failed' | 'bad_response';

/** The outcome of one `listGatewayVaults` attempt — what the registry feeds
 *  into {@link applyFetchOutcome}. */
export type GatewayVaultFetchOutcome =
  | { status: 'loading' }
  | { status: 'ready'; vaults: FlatSwitcherVault[] }
  | { status: 'error'; error: Exclude<FlatSwitcherGatewayStatus, 'loading'> };

/** Cached state for one gateway — stale-while-revalidate: `vaults` holds the
 *  last known-good list (survives a subsequent 'loading' or 'error' outcome)
 *  so a reopened popover paints instantly and a background refresh failure
 *  doesn't blank out data the owner already saw. */
export interface GatewayVaultCacheEntry {
  /** Last known-good vault list, or `undefined` if never successfully fetched. */
  vaults: FlatSwitcherVault[] | undefined;
  /** Status of the MOST RECENT fetch attempt (may be stale relative to `vaults`). */
  status: 'loading' | 'ready' | 'error';
  error?: Exclude<FlatSwitcherGatewayStatus, 'loading'>;
}

export type GatewayVaultCache = Record<string, GatewayVaultCacheEntry>;

/**
 * Fold one fetch outcome into the cache, keeping the previous vault list
 * around across a `'loading'` (refresh in flight) or `'error'` (refresh
 * failed) outcome — only a `'ready'` outcome replaces it. Pure reducer, so
 * "reopen shows the old list instantly, then refreshes" is testable without
 * a real IPC round trip.
 */
export function applyFetchOutcome(
  cache: GatewayVaultCache,
  gatewayId: string,
  outcome: GatewayVaultFetchOutcome,
): GatewayVaultCache {
  const prev = cache[gatewayId];
  let next: GatewayVaultCacheEntry;
  if (outcome.status === 'loading') {
    next = { vaults: prev?.vaults, status: 'loading' };
  } else if (outcome.status === 'ready') {
    next = { vaults: outcome.vaults, status: 'ready' };
  } else {
    next = { vaults: prev?.vaults, status: 'error', error: outcome.error };
  }
  return { ...cache, [gatewayId]: next };
}

/** One row of the flat switcher list — either a live (gateway, vault) pair,
 *  or a single folded row standing in for a gateway with no vaults known
 *  yet (still loading, or its most recent fetch failed). */
export type FlatSwitcherRow =
  | {
      kind: 'pair';
      gatewayId: string;
      gatewayLabel: string;
      gatewayKind: 'local' | 'remote';
      vaultId: string;
      name: string;
      color?: string;
      icon?: string;
      blurb?: string;
      isActive: boolean;
      /** True when this gateway's list is showing cached data while a
       *  background refresh is in flight (stale-while-revalidate). */
      gatewayRefreshing: boolean;
    }
  | {
      kind: 'gateway-status';
      gatewayId: string;
      gatewayLabel: string;
      gatewayKind: 'local' | 'remote';
      status: FlatSwitcherGatewayStatus;
    };

export type PairRow = Extract<FlatSwitcherRow, { kind: 'pair' }>;

/**
 * Which API calls a row selection requires, and in what order. Selecting a
 * pair on the already-active gateway is the cheap existing path (no gateway
 * switch); selecting a pair on another gateway must switch the gateway
 * FIRST, then set the vault — `setActiveVault` writes the per-gateway map
 * entry for whichever gateway is active at the time it lands.
 */
export type SwitcherSelectionPlan =
  | { kind: 'same-gateway'; vaultId: string }
  | { kind: 'cross-gateway'; gatewayId: string; vaultId: string };

export function resolveSelection(row: PairRow, activeGatewayId: string): SwitcherSelectionPlan {
  return row.gatewayId === activeGatewayId
    ? { kind: 'same-gateway', vaultId: row.vaultId }
    : { kind: 'cross-gateway', gatewayId: row.gatewayId, vaultId: row.vaultId };
}

/** The two IPC calls a selection may need — injected so this stays testable
 *  without touching `window.CentraidApi`. */
export interface SwitcherSelectionApi {
  setActiveGateway: (input: { id: string }) => Promise<unknown>;
  setActiveVault: (input: { vaultId?: string }) => Promise<unknown>;
}

/**
 * Apply a resolved selection plan, awaiting `setActiveGateway` before
 * `setActiveVault` for a cross-gateway pick (never in parallel — the vault
 * flip must land against the gateway it's meant for) and skipping the
 * gateway call entirely for a same-gateway pick.
 */
export async function applySelection(
  plan: SwitcherSelectionPlan,
  api: SwitcherSelectionApi,
): Promise<void> {
  if (plan.kind === 'cross-gateway') {
    await api.setActiveGateway({ id: plan.gatewayId });
  }
  await api.setActiveVault({ vaultId: plan.vaultId });
}

/*
 * ── Grouped switcher model (issue #382) ────────────────────────────────
 * The redesigned switcher popover is the single home for choosing AND
 * managing (gateway, vault) pairs: gateway header rows (label, transport
 * badge, status rail) with nested vault rows, rather than one flat list.
 * Reuses the same `GatewayVaultCache` / `applyFetchOutcome` fetch-and-cache
 * machinery above — only the row-shaping is different.
 */

/** User-facing transport chip on a gateway's header row. */
export type SwitcherTransportBadge = 'This Mac' | 'iroh' | 'URL' | 'SSH';

export interface GroupedSwitcherGateway {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: 'local' | 'remote';
  transportBadge: SwitcherTransportBadge;
  /** `'ready'` once at least one vault is known; otherwise the same status
   *  union `FlatSwitcherRow`'s folded row uses. */
  status: FlatSwitcherGatewayStatus | 'ready';
  /** True while a background refresh is in flight (stale-while-revalidate)
   *  — drives the header rail's subtle pulse. */
  gatewayRefreshing: boolean;
  /** Whether the header's "+ New space…" action should render — local and
   *  SSH-capable gateways admin their own vault lifecycle; a plain
   *  ticket/token remote gateway doesn't (design doc step C). */
  canCreateVault: boolean;
  vaults: PairRow[];
}

function transportBadgeFor(gw: FlatSwitcherGateway): SwitcherTransportBadge {
  if (gw.gatewayKind === 'local') return 'This Mac';
  if (gw.transport === 'direct') return 'URL';
  if (gw.hasSsh && gw.transport === undefined) return 'SSH';
  return 'iroh';
}

/**
 * Merge every registered gateway's cached vaults into one header-per-gateway
 * list, each carrying its nested (already-sorted) vault rows. Unlike
 * {@link buildFlatRows}, a gateway ALWAYS gets a header row regardless of
 * whether any vaults are known yet — the header itself carries the
 * loading/error status so the switcher can render "This Mac ▸ (2 spaces)"
 * next to "office ▸ Offline" in one consistent shape.
 */
export function buildGroupedRows(
  gateways: readonly FlatSwitcherGateway[],
  cache: GatewayVaultCache,
  active: { gatewayId: string; vaultId: string },
): GroupedSwitcherGateway[] {
  const groups = gateways.map((gw): GroupedSwitcherGateway => {
    const entry = cache[gw.gatewayId];
    const vaults: PairRow[] = (entry?.vaults ?? [])
      .map(
        (v): PairRow => ({
          blurb: v.blurb,
          color: v.color,
          gatewayId: gw.gatewayId,
          gatewayKind: gw.gatewayKind,
          gatewayLabel: gw.gatewayLabel,
          gatewayRefreshing: entry?.status === 'loading',
          icon: v.icon,
          isActive: gw.gatewayId === active.gatewayId && v.vaultId === active.vaultId,
          kind: 'pair',
          name: v.name,
          vaultId: v.vaultId,
        }),
      )
      .sort((a, b) => {
        if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return {
      canCreateVault: gw.gatewayKind === 'local' || Boolean(gw.hasSsh),
      gatewayId: gw.gatewayId,
      gatewayKind: gw.gatewayKind,
      gatewayLabel: gw.gatewayLabel,
      gatewayRefreshing: entry?.status === 'loading',
      status:
        vaults.length > 0
          ? 'ready'
          : entry?.status === 'error'
            ? (entry.error ?? 'unreachable')
            : 'loading',
      transportBadge: transportBadgeFor(gw),
      vaults,
    };
  });
  return [...groups].sort((a, b) => {
    if (a.gatewayId === active.gatewayId) return -1;
    if (b.gatewayId === active.gatewayId) return 1;
    return a.gatewayLabel.localeCompare(b.gatewayLabel);
  });
}
