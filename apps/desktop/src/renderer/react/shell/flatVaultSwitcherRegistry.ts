/*
 * Impure glue for the flat (gateway, vault) switcher (issue #376, spec #289
 * §7): a module-level cache of every gateway's vault list (so a reopened
 * popover paints instantly — stale-while-revalidate) plus the concurrent
 * `listGateways` + per-gateway `listGatewayVaults` fetch that refreshes it.
 * All the actual merge/sort/selection logic is the pure
 * `flatVaultSwitcher-core.ts`; this file only wires `window.CentraidApi` and
 * owns the cache's lifetime (the whole renderer session — a gateway rarely
 * disappears mid-session, and a stale-but-shown row is strictly better than
 * an empty popover while the network catches up).
 */

import {
  applyFetchOutcome,
  buildSortedFlatRows,
  type FlatSwitcherGateway,
  type FlatSwitcherRow,
  type GatewayVaultCache,
} from './flatVaultSwitcher-core.js';

let cache: GatewayVaultCache = {};
/** The gateway profiles as of the last successful `listGateways()` — lets a
 *  reopened popover paint synchronously (no `await` before the caller can
 *  call `openVaultSwitcher`) even though the gateway list itself is fetched
 *  over IPC. Empty until the first `openFlatVaultRegistry` call resolves. */
let lastGateways: FlatSwitcherGateway[] = [];

/** Test-only escape hatch — production code never needs to reset the cache. */
export function __resetFlatVaultSwitcherCache(): void {
  cache = {};
  lastGateways = [];
}

function toGateway(p: { id: string; label: string; kind: 'local' | 'remote' }): FlatSwitcherGateway {
  return { gatewayId: p.id, gatewayLabel: p.label, gatewayKind: p.kind };
}

/**
 * Synchronous, cache-only rows from the last resolved gateway list — what
 * the trigger should render THE INSTANT the popover opens, before
 * `openFlatVaultRegistry`'s fresh fetch has a chance to land. Empty on a
 * cold start (nothing cached yet); every subsequent open in the session
 * paints instantly from here.
 */
export function getCachedFlatRows(active: { gatewayId: string; vaultId: string }): FlatSwitcherRow[] {
  return buildSortedFlatRows(lastGateways, cache, active);
}

/**
 * Fetch the gateway list, then the current cached (possibly stale) sorted
 * rows for instant paint, and kick off a concurrent per-gateway
 * `listGatewayVaults` refresh — invoking `onUpdate` with the freshly merged
 * rows as each gateway settles so the popover fills in progressively
 * without ever showing a full-popover spinner.
 *
 * Returns the gateway list actually used (the caller needs it for the
 * active-gateway id even before any vault fetch resolves) and the
 * cache-only rows for the very first, synchronous paint.
 */
export async function openFlatVaultRegistry(
  active: { gatewayId: string; vaultId: string },
  onUpdate: (rows: FlatSwitcherRow[]) => void,
): Promise<{ gateways: FlatSwitcherGateway[]; rows: FlatSwitcherRow[] }> {
  const profiles = (await window.CentraidApi.listGateways?.().catch(() => [])) ?? [];
  const gateways = profiles.map(toGateway);
  lastGateways = gateways;

  // Instant paint from whatever's cached (possibly nothing yet, in which
  // case every gateway folds to a 'loading' row until its fetch settles).
  const rows = buildSortedFlatRows(gateways, cache, active);

  // Kick every gateway's refresh concurrently; each one that settles
  // updates the cache and re-emits the full merged+sorted row set so the
  // caller can patch the open popover in place.
  void Promise.all(
    gateways.map(async (gw) => {
      cache = applyFetchOutcome(cache, gw.gatewayId, { status: 'loading' });
      try {
        const result = await window.CentraidApi.listGatewayVaults({ gatewayId: gw.gatewayId });
        cache = applyFetchOutcome(
          cache,
          gw.gatewayId,
          result.ok
            ? { status: 'ready', vaults: result.vaults }
            : { status: 'error', error: result.error },
        );
      } catch {
        cache = applyFetchOutcome(cache, gw.gatewayId, { status: 'error', error: 'unreachable' });
      }
      onUpdate(buildSortedFlatRows(gateways, cache, active));
    }),
  );

  return { gateways, rows };
}
