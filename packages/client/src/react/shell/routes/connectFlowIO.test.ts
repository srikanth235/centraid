/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Connect flow IO error folding (issue #545 B8).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listVaults = vi.fn();
const connectGateway = vi.fn();
const friendlyGatewayError = vi.fn((e: unknown) => (e instanceof Error ? e.message : String(e)));

vi.mock('../../../gateway-client.js', () => ({
  listVaults: () => listVaults(),
}));

vi.mock('./gatewayModals.js', () => ({
  connectGateway: (...a: unknown[]) => connectGateway(...a),
  friendlyGatewayError: (e: unknown) => friendlyGatewayError(e),
}));

import { commitConnectFlow, loadLocalVaults, runConnectivityTest } from './connectFlowIO.js';

beforeEach(() => {
  listVaults.mockReset();
  connectGateway.mockReset();
  window.CentraidApi = {
    getSettings: vi.fn().mockResolvedValue({ activeGatewayId: 'local' }),
    setActiveGateway: vi.fn().mockResolvedValue(undefined),
    createVault: vi.fn().mockResolvedValue({ vaultId: 'v-new', name: 'New' }),
    setActiveVault: vi.fn().mockResolvedValue(undefined),
  } as unknown as typeof window.CentraidApi;
});

describe('runConnectivityTest', () => {
  it('fails closed when bridge is missing', async () => {
    window.CentraidApi = {} as typeof window.CentraidApi;
    const report = await runConnectivityTest({ method: 'gateway', url: 'http://x' } as never);
    expect(report.ok).toBe(false);
    expect(report.error).toBe('unavailable');
  });

  it('folds bridge throw into unreachable reach stage', async () => {
    window.CentraidApi = {
      testGatewayConnection: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    } as unknown as typeof window.CentraidApi;
    const report = await runConnectivityTest({ method: 'gateway', url: 'http://x' } as never);
    expect(report.ok).toBe(false);
    expect(report.error).toBe('unreachable');
    expect(report.stages?.[0]?.detail).toMatch(/ECONNREFUSED/);
  });

  it('returns bridge report on success', async () => {
    const ok = {
      ok: true,
      stages: [{ id: 'reach', label: 'Reach gateway', status: 'ok' }],
      vaults: [],
    };
    window.CentraidApi = {
      testGatewayConnection: vi.fn().mockResolvedValue(ok),
    } as unknown as typeof window.CentraidApi;
    await expect(
      runConnectivityTest({ method: 'gateway', url: 'http://x' } as never),
    ).resolves.toEqual(ok);
  });
});

describe('loadLocalVaults / commitConnectFlow', () => {
  it('maps listVaults rows and tolerates failure', async () => {
    listVaults.mockResolvedValue([{ vaultId: 'v1', name: 'Home', color: '#fff', icon: 'Folder' }]);
    await expect(loadLocalVaults()).resolves.toEqual([
      { vaultId: 'v1', name: 'Home', color: '#fff', icon: 'Folder' },
    ]);
    listVaults.mockRejectedValue(new Error('down'));
    await expect(loadLocalVaults()).resolves.toEqual([]);
  });

  it('rejects commit without a method or vault choice', async () => {
    await expect(commitConnectFlow({ method: null } as never)).rejects.toThrow(
      /No connection method/,
    );
    await expect(
      commitConnectFlow({ method: 'local', vaultChoice: null } as never),
    ).rejects.toThrow(/Pick or create/);
  });
});
