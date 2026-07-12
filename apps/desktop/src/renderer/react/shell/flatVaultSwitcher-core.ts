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
 *  `CentraidGatewayProfile`). */
export interface FlatSwitcherGateway {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: 'local' | 'remote';
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

/**
 * Merge every registered gateway's cached vaults into flat rows. A gateway
 * with no cached vaults (never resolved, or resolved to zero — #289 vaults
 * are never actually empty in practice, but treat it the same as "nothing
 * to show") folds to one `'gateway-status'` row instead of vanishing.
 */
export function buildFlatRows(
  gateways: readonly FlatSwitcherGateway[],
  cache: GatewayVaultCache,
  active: { gatewayId: string; vaultId: string },
): FlatSwitcherRow[] {
  const rows: FlatSwitcherRow[] = [];
  for (const gw of gateways) {
    const entry = cache[gw.gatewayId];
    const vaults = entry?.vaults;
    if (vaults && vaults.length > 0) {
      for (const v of vaults) {
        rows.push({
          kind: 'pair',
          gatewayId: gw.gatewayId,
          gatewayLabel: gw.gatewayLabel,
          gatewayKind: gw.gatewayKind,
          vaultId: v.vaultId,
          name: v.name,
          color: v.color,
          icon: v.icon,
          blurb: v.blurb,
          isActive: gw.gatewayId === active.gatewayId && v.vaultId === active.vaultId,
          gatewayRefreshing: entry?.status === 'loading',
        });
      }
    } else {
      rows.push({
        kind: 'gateway-status',
        gatewayId: gw.gatewayId,
        gatewayLabel: gw.gatewayLabel,
        gatewayKind: gw.gatewayKind,
        status: entry?.status === 'error' ? (entry.error ?? 'unreachable') : 'loading',
      });
    }
  }
  return rows;
}

function rowLabel(row: FlatSwitcherRow): string {
  return row.kind === 'pair' ? row.name : row.gatewayLabel;
}

/**
 * Order rows for display (#289 §7): the current pair first, then the rest
 * of the ACTIVE gateway's vaults, then other gateways alphabetically by
 * label (each gateway's own vaults sorted alphabetically by name). There's
 * no persisted recency signal to sort by (see the caller's doc comment) —
 * this is the "no recency data" branch of the spec's sort rule.
 */
export function sortFlatRows(
  rows: readonly FlatSwitcherRow[],
  active: { gatewayId: string; vaultId: string },
): FlatSwitcherRow[] {
  const withinGateway = (rs: readonly FlatSwitcherRow[]): FlatSwitcherRow[] =>
    [...rs].sort((a, b) => {
      const aActive = a.kind === 'pair' && a.isActive;
      const bActive = b.kind === 'pair' && b.isActive;
      if (aActive !== bActive) return aActive ? -1 : 1;
      return rowLabel(a).localeCompare(rowLabel(b));
    });

  const activeGatewayRows = rows.filter((r) => r.gatewayId === active.gatewayId);
  const otherRows = rows.filter((r) => r.gatewayId !== active.gatewayId);

  const byGateway = new Map<string, FlatSwitcherRow[]>();
  for (const r of otherRows) {
    const list = byGateway.get(r.gatewayId);
    if (list) list.push(r);
    else byGateway.set(r.gatewayId, [r]);
  }
  const gatewayIdsSorted = [...byGateway.keys()].sort((a, b) => {
    const la = byGateway.get(a)![0]!.gatewayLabel;
    const lb = byGateway.get(b)![0]!.gatewayLabel;
    return la.localeCompare(lb);
  });

  return [
    ...withinGateway(activeGatewayRows),
    ...gatewayIdsSorted.flatMap((id) => withinGateway(byGateway.get(id)!)),
  ];
}

/** Build + sort in one call — the shape the popover actually renders. */
export function buildSortedFlatRows(
  gateways: readonly FlatSwitcherGateway[],
  cache: GatewayVaultCache,
  active: { gatewayId: string; vaultId: string },
): FlatSwitcherRow[] {
  return sortFlatRows(buildFlatRows(gateways, cache, active), active);
}

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
