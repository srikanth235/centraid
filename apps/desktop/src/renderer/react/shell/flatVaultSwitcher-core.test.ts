import { describe, expect, it, vi } from 'vitest';
import {
  applyFetchOutcome,
  applySelection,
  buildFlatRows,
  buildSortedFlatRows,
  resolveSelection,
  type FlatSwitcherGateway,
  type GatewayVaultCache,
  type PairRow,
} from './flatVaultSwitcher-core.js';

const gwLocal: FlatSwitcherGateway = { gatewayId: 'local', gatewayLabel: 'This Mac', gatewayKind: 'local' };
const gwHome: FlatSwitcherGateway = { gatewayId: 'home', gatewayLabel: 'home-server', gatewayKind: 'remote' };
const gwOffice: FlatSwitcherGateway = { gatewayId: 'office', gatewayLabel: 'office', gatewayKind: 'remote' };

describe('applyFetchOutcome', () => {
  it('stores a ready result and marks status ready', () => {
    const cache = applyFetchOutcome({}, 'local', {
      status: 'ready',
      vaults: [{ vaultId: 'a', name: 'A' }],
    });
    expect(cache.local).toEqual({ vaults: [{ vaultId: 'a', name: 'A' }], status: 'ready' });
  });

  it('keeps the previous vault list across a loading outcome (stale-while-revalidate)', () => {
    const withData: GatewayVaultCache = {
      home: { vaults: [{ vaultId: 'a', name: 'A' }], status: 'ready' },
    };
    const next = applyFetchOutcome(withData, 'home', { status: 'loading' });
    expect(next.home).toEqual({ vaults: [{ vaultId: 'a', name: 'A' }], status: 'loading' });
  });

  it('keeps the previous vault list across an error outcome, recording the error', () => {
    const withData: GatewayVaultCache = {
      home: { vaults: [{ vaultId: 'a', name: 'A' }], status: 'ready' },
    };
    const next = applyFetchOutcome(withData, 'home', { status: 'error', error: 'unreachable' });
    expect(next.home).toEqual({
      vaults: [{ vaultId: 'a', name: 'A' }],
      status: 'error',
      error: 'unreachable',
    });
  });

  it('records loading with no prior cache as undefined vaults', () => {
    const next = applyFetchOutcome({}, 'office', { status: 'loading' });
    expect(next.office).toEqual({ vaults: undefined, status: 'loading' });
  });

  it('does not mutate the input cache (pure)', () => {
    const cache: GatewayVaultCache = { local: { vaults: undefined, status: 'loading' } };
    const frozen = Object.freeze({ ...cache });
    expect(() => applyFetchOutcome(frozen, 'local', { status: 'ready', vaults: [] })).not.toThrow();
  });
});

describe('buildFlatRows', () => {
  it('emits one pair row per vault for a ready gateway', () => {
    const cache: GatewayVaultCache = {
      local: {
        vaults: [
          { vaultId: 'a', name: 'Personal', color: '#4E68DD' },
          { vaultId: 'b', name: 'Work' },
        ],
        status: 'ready',
      },
    };
    const rows = buildFlatRows([gwLocal], cache, { gatewayId: 'local', vaultId: 'a' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: 'pair', vaultId: 'a', name: 'Personal', isActive: true });
    expect(rows[1]).toMatchObject({ kind: 'pair', vaultId: 'b', name: 'Work', isActive: false });
  });

  it('folds a gateway with no cached vaults into a single loading row', () => {
    const rows = buildFlatRows([gwHome], {}, { gatewayId: 'local', vaultId: 'a' });
    expect(rows).toEqual([
      { kind: 'gateway-status', gatewayId: 'home', gatewayLabel: 'home-server', gatewayKind: 'remote', status: 'loading' },
    ]);
  });

  it('folds an errored gateway with no cache into a single status row carrying the error', () => {
    const cache: GatewayVaultCache = {
      office: { vaults: undefined, status: 'error', error: 'auth_failed' },
    };
    const rows = buildFlatRows([gwOffice], cache, { gatewayId: 'local', vaultId: 'a' });
    expect(rows).toEqual([
      { kind: 'gateway-status', gatewayId: 'office', gatewayLabel: 'office', gatewayKind: 'remote', status: 'auth_failed' },
    ]);
  });

  it('renders cached pairs with gatewayRefreshing=true while a background refresh is in flight', () => {
    const cache: GatewayVaultCache = {
      home: { vaults: [{ vaultId: 'x', name: 'Family' }], status: 'loading' },
    };
    const rows = buildFlatRows([gwHome], cache, { gatewayId: 'local', vaultId: 'a' });
    expect(rows).toEqual([
      {
        kind: 'pair',
        gatewayId: 'home',
        gatewayLabel: 'home-server',
        gatewayKind: 'remote',
        vaultId: 'x',
        name: 'Family',
        color: undefined,
        icon: undefined,
        blurb: undefined,
        isActive: false,
        gatewayRefreshing: true,
      },
    ]);
  });

  it('merges multiple gateways, mixing ready pairs and a folded offline row', () => {
    const cache: GatewayVaultCache = {
      local: { vaults: [{ vaultId: 'a', name: 'Personal' }], status: 'ready' },
      home: { vaults: [{ vaultId: 'x', name: 'Family' }], status: 'ready' },
      office: { vaults: undefined, status: 'error', error: 'unreachable' },
    };
    const rows = buildFlatRows([gwLocal, gwHome, gwOffice], cache, {
      gatewayId: 'local',
      vaultId: 'a',
    });
    expect(rows.map((r) => r.kind)).toEqual(['pair', 'pair', 'gateway-status']);
    expect(rows.filter((r) => r.kind === 'pair')).toHaveLength(2);
  });
});

describe('sortFlatRows / buildSortedFlatRows', () => {
  it('puts the current pair first', () => {
    const cache: GatewayVaultCache = {
      local: {
        vaults: [
          { vaultId: 'a', name: 'Zebra' },
          { vaultId: 'b', name: 'Alpha' },
        ],
        status: 'ready',
      },
    };
    const rows = buildSortedFlatRows([gwLocal], cache, { gatewayId: 'local', vaultId: 'a' });
    expect(rows.map((r) => (r as PairRow).vaultId)).toEqual(['a', 'b']);
  });

  it('sorts the active gateway block before other gateways, other gateways alphabetically by label', () => {
    const cache: GatewayVaultCache = {
      local: { vaults: [{ vaultId: 'a', name: 'Personal' }], status: 'ready' },
      office: { vaults: [{ vaultId: 'y', name: 'Team' }], status: 'ready' },
      home: { vaults: [{ vaultId: 'x', name: 'Family' }], status: 'ready' },
    };
    const rows = buildSortedFlatRows([gwOffice, gwLocal, gwHome], cache, {
      gatewayId: 'local',
      vaultId: 'a',
    });
    expect(rows.map((r) => r.gatewayId)).toEqual(['local', 'home', 'office']);
  });

  it('sorts vaults within a non-active gateway alphabetically', () => {
    const cache: GatewayVaultCache = {
      local: { vaults: [{ vaultId: 'a', name: 'Personal' }], status: 'ready' },
      home: {
        vaults: [
          { vaultId: 'z', name: 'Zeta' },
          { vaultId: 'y', name: 'Alpha' },
        ],
        status: 'ready',
      },
    };
    const rows = buildSortedFlatRows([gwLocal, gwHome], cache, { gatewayId: 'local', vaultId: 'a' });
    const homeRows = rows.filter((r) => r.gatewayId === 'home') as PairRow[];
    expect(homeRows.map((r) => r.vaultId)).toEqual(['y', 'z']);
  });

  it('places a folded offline-gateway row in its alphabetical slot among other gateways', () => {
    const cache: GatewayVaultCache = {
      local: { vaults: [{ vaultId: 'a', name: 'Personal' }], status: 'ready' },
      home: { vaults: [{ vaultId: 'x', name: 'Family' }], status: 'ready' },
      office: { vaults: undefined, status: 'error', error: 'unreachable' },
    };
    // "office" > "home" alphabetically, so it sorts after home's pair row.
    const rows = buildSortedFlatRows([gwOffice, gwHome, gwLocal], cache, {
      gatewayId: 'local',
      vaultId: 'a',
    });
    expect(rows.map((r) => r.gatewayId)).toEqual(['local', 'home', 'office']);
    expect(rows[2]!.kind).toBe('gateway-status');
  });
});

describe('resolveSelection', () => {
  const pair = (gatewayId: string, vaultId: string): PairRow => ({
    kind: 'pair',
    gatewayId,
    gatewayLabel: gatewayId,
    gatewayKind: 'remote',
    vaultId,
    name: vaultId,
    isActive: false,
    gatewayRefreshing: false,
  });

  it('resolves a same-gateway plan for the active gateway', () => {
    expect(resolveSelection(pair('local', 'b'), 'local')).toEqual({
      kind: 'same-gateway',
      vaultId: 'b',
    });
  });

  it('resolves a cross-gateway plan for another gateway', () => {
    expect(resolveSelection(pair('home', 'x'), 'local')).toEqual({
      kind: 'cross-gateway',
      gatewayId: 'home',
      vaultId: 'x',
    });
  });
});

describe('applySelection', () => {
  it('same-gateway: calls only setActiveVault', async () => {
    const setActiveGateway = vi.fn().mockResolvedValue({});
    const setActiveVault = vi.fn().mockResolvedValue({});
    await applySelection({ kind: 'same-gateway', vaultId: 'b' }, { setActiveGateway, setActiveVault });
    expect(setActiveGateway).not.toHaveBeenCalled();
    expect(setActiveVault).toHaveBeenCalledWith({ vaultId: 'b' });
  });

  it('cross-gateway: awaits setActiveGateway before calling setActiveVault', async () => {
    const order: string[] = [];
    const setActiveGateway = vi.fn(async (input: { id: string }) => {
      order.push(`gateway:${input.id}`);
      await Promise.resolve();
    });
    const setActiveVault = vi.fn(async (input: { vaultId?: string }) => {
      order.push(`vault:${input.vaultId}`);
    });
    await applySelection(
      { kind: 'cross-gateway', gatewayId: 'home', vaultId: 'x' },
      { setActiveGateway, setActiveVault },
    );
    expect(order).toEqual(['gateway:home', 'vault:x']);
  });

  it('cross-gateway: does not call setActiveVault before setActiveGateway resolves', async () => {
    let gatewayResolved = false;
    const setActiveGateway = vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            gatewayResolved = true;
            resolve({});
          }, 0);
        }),
    );
    const setActiveVault = vi.fn(async () => {
      expect(gatewayResolved).toBe(true);
      return {};
    });
    await applySelection(
      { kind: 'cross-gateway', gatewayId: 'home', vaultId: 'x' },
      { setActiveGateway, setActiveVault },
    );
    expect(setActiveVault).toHaveBeenCalledTimes(1);
  });
});
