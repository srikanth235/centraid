import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFlatVaultSwitcherCache,
  getCachedGroupedRows,
  openGroupedVaultRegistry,
  refreshGroupedGateway,
} from './flatVaultSwitcherRegistry.js';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((_resolve) => (resolve = _resolve));
  return { promise, resolve };
}

beforeEach(() => {
  __resetFlatVaultSwitcherCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetFlatVaultSwitcherCache();
});

const active = { gatewayId: 'local', vaultId: 'a' };

describe('openGroupedVaultRegistry / getCachedGroupedRows', () => {
  it('returns one header per gateway on first open, filled in via onUpdate', async () => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    (globalThis as unknown as typeof window).CentraidApi = {
      listGateways: () =>
        Promise.resolve([
          {
            id: 'local',
            label: 'This Mac',
            kind: 'local',
            displayName: '',
            avatarColor: '',
            createdAt: '',
          },
        ]),
      listGatewayVaults: () =>
        Promise.resolve({ ok: true, vaults: [{ vaultId: 'a', name: 'Personal' }] }),
    } as unknown as typeof window.CentraidApi;

    const updates: unknown[][] = [];
    const { rows } = await openGroupedVaultRegistry(active, (r) => updates.push(r));
    expect(rows).toEqual([
      {
        canCreateVault: true,
        gatewayId: 'local',
        gatewayKind: 'local',
        gatewayLabel: 'This Mac',
        gatewayRefreshing: false,
        status: 'loading',
        transportBadge: 'This Mac',
        vaults: [],
      },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates[updates.length - 1]).toEqual([
      expect.objectContaining({
        gatewayId: 'local',
        status: 'ready',
        vaults: [expect.objectContaining({ vaultId: 'a' })],
      }),
    ]);
    expect(getCachedGroupedRows(active)[0]?.status).toBe('ready');
  });

  it('reuses the cache on a second open — instant rows from the prior fetch, no waiting', async () => {
    const listGatewayVaults = vi
      .fn()
      .mockResolvedValue({ ok: true, vaults: [{ vaultId: 'a', name: 'Personal' }] });
    (globalThis as unknown as typeof window).CentraidApi = {
      listGateways: () =>
        Promise.resolve([
          {
            id: 'local',
            label: 'This Mac',
            kind: 'local',
            displayName: 'This Mac',
            avatarColor: '#000',
            createdAt: '',
          },
        ]),
      listGatewayVaults,
    } as unknown as typeof window.CentraidApi;

    await openGroupedVaultRegistry(active, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { rows } = await openGroupedVaultRegistry(active, () => {});
    expect(rows[0]?.vaults).toEqual([
      expect.objectContaining({ kind: 'pair', vaultId: 'a', name: 'Personal', isActive: true }),
    ]);
    // Second open still triggers a background refresh (stale-while-revalidate).
    expect(listGatewayVaults).toHaveBeenCalledTimes(2);
  });

  it('folds an unreachable gateway to an error status without blocking other gateways', async () => {
    const homeDeferred = deferred<{ ok: true; vaults: { vaultId: string; name: string }[] }>();
    const listGatewayVaults = vi.fn((input: { gatewayId: string }) => {
      if (input.gatewayId === 'office')
        return Promise.resolve({ ok: false, error: 'unreachable' as const });
      return homeDeferred.promise;
    });
    (globalThis as unknown as typeof window).CentraidApi = {
      listGateways: () =>
        Promise.resolve([
          {
            id: 'local',
            label: 'This Mac',
            kind: 'local',
            displayName: '',
            avatarColor: '',
            createdAt: '',
          },
          {
            id: 'office',
            label: 'office',
            kind: 'remote',
            displayName: '',
            avatarColor: '',
            createdAt: '',
          },
        ]),
      listGatewayVaults,
    } as unknown as typeof window.CentraidApi;

    const updates: unknown[][] = [];
    await openGroupedVaultRegistry({ gatewayId: 'local', vaultId: 'a' }, (r) => updates.push(r));
    homeDeferred.resolve({ ok: true, vaults: [{ vaultId: 'a', name: 'Personal' }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const last = updates[updates.length - 1]!;
    const officeRow = last.find((r) => (r as { gatewayId: string }).gatewayId === 'office') as {
      status: string;
      vaults: unknown[];
    };
    expect(officeRow).toMatchObject({ status: 'unreachable', vaults: [] });
  });

  it('degrades to an empty gateway list without throwing when listGateways is absent', async () => {
    (globalThis as unknown as typeof window).CentraidApi =
      {} as unknown as typeof window.CentraidApi;
    const { gateways, rows } = await openGroupedVaultRegistry(active, () => {});
    expect(gateways).toEqual([]);
    expect(rows).toEqual([]);
  });

  it('refreshGroupedGateway refreshes only the named gateway and returns the merged grouped rows', async () => {
    const listGatewayVaults = vi.fn((input: { gatewayId: string }) =>
      Promise.resolve({ ok: true, vaults: [{ vaultId: input.gatewayId, name: input.gatewayId }] }),
    );
    (globalThis as unknown as typeof window).CentraidApi = {
      listGateways: () =>
        Promise.resolve([
          {
            id: 'local',
            label: 'This Mac',
            kind: 'local',
            displayName: '',
            avatarColor: '',
            createdAt: '',
          },
          {
            id: 'home',
            label: 'home-server',
            kind: 'remote',
            displayName: '',
            avatarColor: '',
            createdAt: '',
          },
        ]),
      listGatewayVaults,
    } as unknown as typeof window.CentraidApi;

    await openGroupedVaultRegistry(active, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    listGatewayVaults.mockClear();

    const rows = await refreshGroupedGateway('home', active);
    expect(listGatewayVaults).toHaveBeenCalledTimes(1);
    expect(listGatewayVaults).toHaveBeenCalledWith({ gatewayId: 'home' });
    expect(rows.find((g) => g.gatewayId === 'home')?.vaults).toEqual([
      expect.objectContaining({ vaultId: 'home' }),
    ]);
  });
});
