/*
 * Impure glue for the grouped (gateway, vault) switcher (issue #382, prior
 * art #376/#289 §7): a module-level cache of every gateway's vault list (so
 * a reopened popover paints instantly — stale-while-revalidate) plus the
 * concurrent `listGateways` + per-gateway `listGatewayVaults` fetch that
 * refreshes it. All the actual merge/sort/selection logic is the pure
 * `flatVaultSwitcher-core.ts`; this file only wires `window.CentraidApi` and
 * owns the cache's lifetime (the whole renderer session — a gateway rarely
 * disappears mid-session, and a stale-but-shown row is strictly better than
 * an empty popover while the network catches up).
 */

import {
  applyFetchOutcome,
  buildGroupedRows,
  type FlatSwitcherGateway,
  type GatewayVaultCache,
  type GroupedSwitcherGateway,
} from './flatVaultSwitcher-core.js';

let cache: GatewayVaultCache = {};
/** The gateway profiles as of the last successful `listGateways()` — lets a
 *  reopened popover paint synchronously (no `await` before the caller can
 *  call `openVaultSwitcher`) even though the gateway list itself is fetched
 *  over IPC. Empty until the first `openGroupedVaultRegistry` call resolves. */
let lastGateways: FlatSwitcherGateway[] = [];

/** Test-only escape hatch — production code never needs to reset the cache. */
export function __resetFlatVaultSwitcherCache(): void {
  cache = {};
  lastGateways = [];
}

// `hasSsh` isn't in `centraid-api.d.ts`'s `CentraidGatewayProfile` yet — it's
// a new field the backend half of issue #382 adds to `listGateways`'s DTO
// alongside `transport`. Read defensively (optional cast) so this file
// type-checks and degrades to `hasSsh: undefined` (no "+ New space" affordance
// for that gateway) against an older/unwired build rather than throwing.
type ProfileWithSsh = {
  id: string;
  label: string;
  kind: 'local' | 'remote';
  transport?: 'local' | 'iroh' | 'direct';
  ssh?: unknown;
};

function toGateway(p: ProfileWithSsh): FlatSwitcherGateway {
  return {
    gatewayId: p.id,
    gatewayKind: p.kind,
    gatewayLabel: p.label,
    hasSsh: p.ssh !== undefined,
    transport: p.transport,
  };
}

/**
 * Synchronous, cache-only grouped rows from the last resolved gateway list —
 * what the trigger should render THE INSTANT the popover opens, before
 * `openGroupedVaultRegistry`'s fresh fetch has a chance to land. Empty on a
 * cold start (nothing cached yet); every subsequent open in the session
 * paints instantly from here.
 */
export function getCachedGroupedRows(active: {
  gatewayId: string;
  vaultId: string;
}): GroupedSwitcherGateway[] {
  return buildGroupedRows(lastGateways, cache, active);
}

async function fetchGateways(): Promise<FlatSwitcherGateway[]> {
  const profiles = (await window.CentraidApi.listGateways?.().catch(() => [])) ?? [];
  const gateways = profiles.map(toGateway);
  lastGateways = gateways;
  return gateways;
}

/** Refresh one gateway's vault list into the shared cache. Never throws —
 *  folds any rejection to the same `'unreachable'` outcome
 *  `listGatewayVaults` itself would report. */
async function refreshOneGateway(gatewayId: string): Promise<void> {
  cache = applyFetchOutcome(cache, gatewayId, { status: 'loading' });
  try {
    const result = await window.CentraidApi.listGatewayVaults({ gatewayId });
    cache = applyFetchOutcome(
      cache,
      gatewayId,
      result.ok
        ? { status: 'ready', vaults: result.vaults }
        : { status: 'error', error: result.error },
    );
  } catch {
    cache = applyFetchOutcome(cache, gatewayId, { status: 'error', error: 'unreachable' });
  }
}

/**
 * Fetch the gateway list, then the current cached (possibly stale) grouped
 * rows for instant paint, and kick off a concurrent per-gateway
 * `listGatewayVaults` refresh — invoking `onUpdate` with the freshly merged
 * rows as each gateway settles so the popover fills in progressively
 * without ever showing a full-popover spinner (issue #382).
 *
 * Returns the gateway list actually used (the caller needs it for the
 * active-gateway id even before any vault fetch resolves) and the
 * cache-only rows for the very first, synchronous paint.
 */
export async function openGroupedVaultRegistry(
  active: { gatewayId: string; vaultId: string },
  onUpdate: (rows: GroupedSwitcherGateway[]) => void,
): Promise<{ gateways: FlatSwitcherGateway[]; rows: GroupedSwitcherGateway[] }> {
  const gateways = await fetchGateways();
  const rows = buildGroupedRows(gateways, cache, active);

  void Promise.all(
    gateways.map(async (gw) => {
      await refreshOneGateway(gw.gatewayId);
      onUpdate(buildGroupedRows(gateways, cache, active));
    }),
  );

  return { gateways, rows };
}

/** Refresh a single gateway's vaults on demand (e.g. right after creating a
 *  vault on it from the switcher) and return the freshly merged grouped
 *  rows, without re-fetching every OTHER gateway. */
export async function refreshGroupedGateway(
  gatewayId: string,
  active: { gatewayId: string; vaultId: string },
): Promise<GroupedSwitcherGateway[]> {
  await refreshOneGateway(gatewayId);
  return buildGroupedRows(lastGateways, cache, active);
}
