/*
 * The gateway registry behind the sidebar's identity row (issue #599).
 *
 * This is the surviving half of the retired (gateway, space) switcher: since
 * Decision 14 the space switcher is gone — Household lists the member's spaces
 * and every creation flow names its own target — so the only thing left to
 * choose from the sidebar is which GATEWAY this client talks to, and only when
 * more than one is registered.
 *
 * `buildGatewayRows` is pure (no `window`), so the merge/sort/status folding is
 * unit-testable; the rest wires `window.CentraidApi` and owns a module-level
 * cache for the whole renderer session, so a reopened popover paints instantly
 * (stale-while-revalidate) rather than showing a spinner.
 *
 * A gateway's reachability still comes from `listGatewayVaults` — it is the one
 * per-gateway call that proves the connection works end to end, and its count
 * doubles as the row's "N spaces" subtitle.
 */

/** Minimal shape of a gateway profile these rows need. `ssh` is read
 *  defensively (the field post-dates some profiles) and only decides the
 *  transport chip. */
export interface RegistryGateway {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: 'local' | 'remote';
  hasSsh?: boolean;
}

/** Why a gateway's probe didn't come back, plus `'loading'` for one still in
 *  flight. Mirrors `CentraidListGatewayVaultsResult`'s error union. */
export type GatewayProbeStatus = 'loading' | 'unreachable' | 'auth_failed' | 'bad_response';

export type GatewayProbeOutcome =
  | { status: 'loading' }
  | { status: 'ready'; spaceCount: number }
  | { status: 'error'; error: Exclude<GatewayProbeStatus, 'loading'> };

/** Cached probe state for one gateway. `spaceCount` survives a later
 *  `'loading'`/`'error'` outcome so a background refresh failure never blanks
 *  out a number the owner already saw. */
export interface GatewayProbeEntry {
  spaceCount: number | undefined;
  status: 'loading' | 'ready' | 'error';
  error?: Exclude<GatewayProbeStatus, 'loading'>;
}

export type GatewayProbeCache = Record<string, GatewayProbeEntry>;

/** User-facing transport chip. */
export type GatewayTransportBadge = 'This Mac' | 'iroh' | 'SSH';

/** One row of the gateway switcher. */
export interface GatewayRow {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: 'local' | 'remote';
  transportBadge: GatewayTransportBadge;
  status: GatewayProbeStatus | 'ready';
  /** Known space count, once a probe succeeded. */
  spaceCount: number | undefined;
  isActive: boolean;
  /** `'local'` is the primordial gateway — never removable (mirrors
   *  `removeGateway`'s own refusal). */
  canRemove: boolean;
}

/** Fold one probe outcome into the cache. Pure reducer. */
export function applyProbeOutcome(
  cache: GatewayProbeCache,
  gatewayId: string,
  outcome: GatewayProbeOutcome,
): GatewayProbeCache {
  const prev = cache[gatewayId];
  let next: GatewayProbeEntry;
  if (outcome.status === 'loading') {
    next = { spaceCount: prev?.spaceCount, status: 'loading' };
  } else if (outcome.status === 'ready') {
    next = { spaceCount: outcome.spaceCount, status: 'ready' };
  } else {
    next = {
      spaceCount: prev?.spaceCount,
      status: 'error',
      error: outcome.error,
    };
  }
  return { ...cache, [gatewayId]: next };
}

function transportBadgeFor(gw: RegistryGateway): GatewayTransportBadge {
  if (gw.gatewayKind === 'local') return 'This Mac';
  return gw.hasSsh ? 'SSH' : 'iroh';
}

/**
 * Merge the registered gateways with whatever their probes reported, active
 * gateway first and the rest alphabetical.
 */
export function buildGatewayRows(
  gateways: readonly RegistryGateway[],
  cache: GatewayProbeCache,
  activeGatewayId: string,
): GatewayRow[] {
  const rows = gateways.map((gw): GatewayRow => {
    const entry = cache[gw.gatewayId];
    return {
      canRemove: gw.gatewayKind !== 'local',
      gatewayId: gw.gatewayId,
      gatewayKind: gw.gatewayKind,
      gatewayLabel: gw.gatewayLabel,
      isActive: gw.gatewayId === activeGatewayId,
      spaceCount: entry?.spaceCount,
      status:
        entry?.status === 'ready'
          ? 'ready'
          : entry?.status === 'error'
            ? (entry.error ?? 'unreachable')
            : 'loading',
      transportBadge: transportBadgeFor(gw),
    };
  });
  return [...rows].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return a.gatewayLabel.localeCompare(b.gatewayLabel);
  });
}

// ── Impure glue ────────────────────────────────────────────────────────────

let cache: GatewayProbeCache = {};
let lastGateways: RegistryGateway[] = [];

// `ssh` isn't on `CentraidGatewayProfile` in every host build; read it through
// a widened shape so this degrades to "no SSH chip" rather than failing to
// type-check against an older bridge.
type ProfileWithSsh = {
  id: string;
  label: string;
  kind: 'local' | 'remote';
  ssh?: unknown;
};

function toRegistryGateway(p: ProfileWithSsh): RegistryGateway {
  return {
    gatewayId: p.id,
    gatewayKind: p.kind,
    gatewayLabel: p.label,
    hasSsh: p.ssh !== undefined,
  };
}

/** How many gateways this client knows about — the >1 gate on showing the
 *  switcher at all. Resolves `0` when the host exposes no gateway list. */
export async function countGateways(): Promise<number> {
  const profiles = (await window.CentraidApi.listGateways?.().catch(() => [])) ?? [];
  lastGateways = profiles.map(toRegistryGateway);
  return lastGateways.length;
}

/** Cache-only rows for the instant first paint, before any probe lands. */
export function getCachedGatewayRows(activeGatewayId: string): GatewayRow[] {
  return buildGatewayRows(lastGateways, cache, activeGatewayId);
}

/** Probe one gateway into the shared cache. Never throws — folds any rejection
 *  to the same `'unreachable'` outcome `listGatewayVaults` reports itself. */
async function probeOneGateway(gatewayId: string): Promise<void> {
  cache = applyProbeOutcome(cache, gatewayId, { status: 'loading' });
  try {
    const result = await window.CentraidApi.listGatewayVaults({ gatewayId });
    cache = applyProbeOutcome(
      cache,
      gatewayId,
      result.ok
        ? { status: 'ready', spaceCount: result.vaults.length }
        : { status: 'error', error: result.error },
    );
  } catch {
    cache = applyProbeOutcome(cache, gatewayId, {
      status: 'error',
      error: 'unreachable',
    });
  }
}

/**
 * Refresh the gateway list, return the rows for the first paint, and kick off a
 * concurrent per-gateway probe — invoking `onUpdate` with freshly merged rows as
 * each settles, so the popover fills in progressively instead of blocking.
 */
export async function openGatewayRegistry(
  activeGatewayId: string,
  onUpdate: (rows: GatewayRow[]) => void,
): Promise<GatewayRow[]> {
  await countGateways();
  const gateways = lastGateways;
  void Promise.all(
    gateways.map(async (gw) => {
      await probeOneGateway(gw.gatewayId);
      onUpdate(buildGatewayRows(gateways, cache, activeGatewayId));
    }),
  );
  return buildGatewayRows(gateways, cache, activeGatewayId);
}
