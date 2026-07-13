import { describe, expect, it, vi } from 'vitest';
import {
  applyFetchOutcome,
  applySelection,
  buildGroupedRows,
  resolveSelection,
  type FlatSwitcherGateway,
  type GatewayVaultCache,
  type PairRow,
} from './flatVaultSwitcher-core.js';

const gwLocal: FlatSwitcherGateway = {
  gatewayId: 'local',
  gatewayLabel: 'This Mac',
  gatewayKind: 'local',
};
const gwHome: FlatSwitcherGateway = {
  gatewayId: 'home',
  gatewayLabel: 'home-server',
  gatewayKind: 'remote',
};
const gwOffice: FlatSwitcherGateway = {
  gatewayId: 'office',
  gatewayLabel: 'office',
  gatewayKind: 'remote',
};

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

describe('buildGroupedRows', () => {
  it('emits one header per gateway with sorted nested vaults, active gateway first', () => {
    const cache: GatewayVaultCache = {
      home: {
        vaults: [
          { name: 'Zeta', vaultId: 'z' },
          { name: 'Alpha', vaultId: 'y' },
        ],
        status: 'ready',
      },
      local: { vaults: [{ name: 'Personal', vaultId: 'a' }], status: 'ready' },
    };
    const groups = buildGroupedRows([gwHome, gwLocal], cache, { gatewayId: 'local', vaultId: 'a' });
    expect(groups.map((g) => g.gatewayId)).toEqual(['local', 'home']);
    expect(groups[1]!.vaults.map((v) => v.vaultId)).toEqual(['y', 'z']);
    expect(groups[0]!.vaults[0]).toMatchObject({ isActive: true, vaultId: 'a' });
  });

  it('still emits a header for a gateway with no cached vaults, folded to a loading status', () => {
    const groups = buildGroupedRows([gwHome], {}, { gatewayId: 'local', vaultId: 'a' });
    expect(groups).toEqual([
      {
        canCreateVault: false,
        gatewayId: 'home',
        gatewayKind: 'remote',
        gatewayLabel: 'home-server',
        gatewayRefreshing: false,
        status: 'loading',
        transportBadge: 'iroh',
        vaults: [],
      },
    ]);
  });

  it('carries the fetch error onto the header status when there are no cached vaults', () => {
    const cache: GatewayVaultCache = {
      office: { vaults: undefined, status: 'error', error: 'auth_failed' },
    };
    const groups = buildGroupedRows([gwOffice], cache, { gatewayId: 'local', vaultId: 'a' });
    expect(groups[0]!.status).toBe('auth_failed');
  });

  it('transport badge: local -> "This Mac", direct -> "URL", ssh-capable remote -> "SSH", else "iroh"', () => {
    const local: FlatSwitcherGateway = {
      gatewayId: 'local',
      gatewayKind: 'local',
      gatewayLabel: 'This Mac',
    };
    const direct: FlatSwitcherGateway = {
      gatewayId: 'd',
      gatewayKind: 'remote',
      gatewayLabel: 'd',
      transport: 'direct',
    };
    const ssh: FlatSwitcherGateway = {
      gatewayId: 's',
      gatewayKind: 'remote',
      gatewayLabel: 's',
      hasSsh: true,
    };
    const iroh: FlatSwitcherGateway = {
      gatewayId: 'i',
      gatewayKind: 'remote',
      gatewayLabel: 'i',
      transport: 'iroh',
    };
    const groups = buildGroupedRows(
      [local, direct, ssh, iroh],
      {},
      { gatewayId: 'local', vaultId: '' },
    );
    const badge = (id: string): string => groups.find((g) => g.gatewayId === id)!.transportBadge;
    expect(badge('local')).toBe('This Mac');
    expect(badge('d')).toBe('URL');
    expect(badge('s')).toBe('SSH');
    expect(badge('i')).toBe('iroh');
  });

  it('canCreateVault is true for local and ssh-capable gateways, false otherwise', () => {
    const local: FlatSwitcherGateway = {
      gatewayId: 'local',
      gatewayKind: 'local',
      gatewayLabel: 'This Mac',
    };
    const ssh: FlatSwitcherGateway = {
      gatewayId: 's',
      gatewayKind: 'remote',
      gatewayLabel: 's',
      hasSsh: true,
    };
    const plain: FlatSwitcherGateway = { gatewayId: 'p', gatewayKind: 'remote', gatewayLabel: 'p' };
    const groups = buildGroupedRows([local, ssh, plain], {}, { gatewayId: 'local', vaultId: '' });
    const canCreate = (id: string): boolean =>
      groups.find((g) => g.gatewayId === id)!.canCreateVault;
    expect(canCreate('local')).toBe(true);
    expect(canCreate('s')).toBe(true);
    expect(canCreate('p')).toBe(false);
  });

  it('gatewayRefreshing reflects an in-flight refresh even once vaults are cached', () => {
    const cache: GatewayVaultCache = {
      local: { vaults: [{ name: 'A', vaultId: 'a' }], status: 'loading' },
    };
    const groups = buildGroupedRows([gwLocal], cache, { gatewayId: 'local', vaultId: 'a' });
    expect(groups[0]!.gatewayRefreshing).toBe(true);
    expect(groups[0]!.status).toBe('ready');
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
    await applySelection(
      { kind: 'same-gateway', vaultId: 'b' },
      { setActiveGateway, setActiveVault },
    );
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
