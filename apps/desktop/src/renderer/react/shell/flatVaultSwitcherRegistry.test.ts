import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetFlatVaultSwitcherCache,
  getCachedFlatRows,
  openFlatVaultRegistry,
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

describe('openFlatVaultRegistry', () => {
  it('returns a loading row per gateway on first open (nothing cached yet), then fills in via onUpdate', async () => {
    const listGatewayVaults = vi.fn().mockResolvedValue({ ok: true, vaults: [{ vaultId: 'a', name: 'Personal' }] });
    (globalThis as unknown as { window: unknown }).window = globalThis;
    (globalThis as unknown as typeof window).CentraidApi = {
      listGateways: () =>
        Promise.resolve([{ id: 'local', label: 'This Mac', kind: 'local', displayName: 'This Mac', avatarColor: '#000', createdAt: '' }]),
      listGatewayVaults,
    } as unknown as typeof window.CentraidApi;

    const updates: unknown[][] = [];
    const { rows } = await openFlatVaultRegistry(active, (r) => updates.push(r));
    expect(rows).toEqual([
      { kind: 'gateway-status', gatewayId: 'local', gatewayLabel: 'This Mac', gatewayKind: 'local', status: 'loading' },
    ]);

    // Let the concurrent listGatewayVaults resolution + onUpdate flush.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual([
      expect.objectContaining({ kind: 'pair', vaultId: 'a', name: 'Personal', isActive: true }),
    ]);
  });

  it('reuses the cache on a second open — instant rows from the prior fetch, no waiting', async () => {
    const listGatewayVaults = vi.fn().mockResolvedValue({ ok: true, vaults: [{ vaultId: 'a', name: 'Personal' }] });
    (globalThis as unknown as typeof window).CentraidApi = {
      listGateways: () =>
        Promise.resolve([{ id: 'local', label: 'This Mac', kind: 'local', displayName: 'This Mac', avatarColor: '#000', createdAt: '' }]),
      listGatewayVaults,
    } as unknown as typeof window.CentraidApi;

    await openFlatVaultRegistry(active, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));

    const { rows } = await openFlatVaultRegistry(active, () => {});
    expect(rows).toEqual([
      expect.objectContaining({ kind: 'pair', vaultId: 'a', name: 'Personal', isActive: true }),
    ]);
    // Second open still triggers a background refresh (stale-while-revalidate).
    expect(listGatewayVaults).toHaveBeenCalledTimes(2);
  });

  it('folds an unreachable gateway to a single disabled status row without blocking other gateways', async () => {
    const homeDeferred = deferred<{ ok: true; vaults: { vaultId: string; name: string }[] }>();
    const listGatewayVaults = vi.fn((input: { gatewayId: string }) => {
      if (input.gatewayId === 'office') return Promise.resolve({ ok: false, error: 'unreachable' as const });
      return homeDeferred.promise;
    });
    (globalThis as unknown as typeof window).CentraidApi = {
      listGateways: () =>
        Promise.resolve([
          { id: 'local', label: 'This Mac', kind: 'local', displayName: '', avatarColor: '', createdAt: '' },
          { id: 'office', label: 'office', kind: 'remote', displayName: '', avatarColor: '', createdAt: '' },
        ]),
      listGatewayVaults,
    } as unknown as typeof window.CentraidApi;

    const updates: unknown[][] = [];
    await openFlatVaultRegistry({ gatewayId: 'local', vaultId: 'a' }, (r) => updates.push(r));
    homeDeferred.resolve({ ok: true, vaults: [{ vaultId: 'a', name: 'Personal' }] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const last = updates[updates.length - 1]!;
    const officeRow = last.find((r) => (r as { gatewayId: string }).gatewayId === 'office') as {
      kind: string;
      status: string;
    };
    expect(officeRow).toEqual({
      kind: 'gateway-status',
      gatewayId: 'office',
      gatewayLabel: 'office',
      gatewayKind: 'remote',
      status: 'unreachable',
    });
  });

  it('getCachedFlatRows is empty before any open, then reflects the cache synchronously after', async () => {
    expect(getCachedFlatRows(active)).toEqual([]);
    (globalThis as unknown as typeof window).CentraidApi = {
      listGateways: () =>
        Promise.resolve([{ id: 'local', label: 'This Mac', kind: 'local', displayName: '', avatarColor: '', createdAt: '' }]),
      listGatewayVaults: () => Promise.resolve({ ok: true, vaults: [{ vaultId: 'a', name: 'Personal' }] }),
    } as unknown as typeof window.CentraidApi;
    await openFlatVaultRegistry(active, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getCachedFlatRows(active)).toEqual([
      expect.objectContaining({ kind: 'pair', vaultId: 'a', name: 'Personal' }),
    ]);
  });

  it('degrades to an empty gateway list without throwing when listGateways is absent', async () => {
    (globalThis as unknown as typeof window).CentraidApi = {} as unknown as typeof window.CentraidApi;
    const { gateways, rows } = await openFlatVaultRegistry(active, () => {});
    expect(gateways).toEqual([]);
    expect(rows).toEqual([]);
  });
});
