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

import {
  commitConnectFlow,
  connectFreshLocalGateway,
  loadLocalVaults,
  runConnectivityTest,
} from './connectFlowIO.js';

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
  it('maps listVaults rows on a successful read', async () => {
    listVaults.mockResolvedValue([{ vaultId: 'v1', name: 'Home', color: '#fff', icon: 'Folder' }]);
    await expect(loadLocalVaults()).resolves.toEqual({
      ok: true,
      vaults: [{ vaultId: 'v1', name: 'Home', color: '#fff', icon: 'Folder' }],
    });
  });

  // Issue #603 W4: an unreachable gateway used to fold into an empty list,
  // which the UI then rendered as "no spaces here" and offered to create one
  // against. Failure must stay distinguishable from an empty registry.
  it('reports a transport failure instead of an empty list', async () => {
    listVaults.mockRejectedValue(new Error('down'));
    const result = await loadLocalVaults();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.message).toMatch(/down/);
  });

  it('reports a gateway with no vault route as a failure too', async () => {
    listVaults.mockResolvedValue(undefined);
    expect((await loadLocalVaults()).ok).toBe(false);
  });

  it('an empty-but-readable registry is a success with zero vaults', async () => {
    listVaults.mockResolvedValue([]);
    await expect(loadLocalVaults()).resolves.toEqual({ ok: true, vaults: [] });
  });

  it('connectFreshLocalGateway addresses the auto-founded Personal vault', async () => {
    listVaults.mockResolvedValue([
      { vaultId: 'shared', name: 'Shared' },
      { vaultId: 'personal', name: 'Personal' },
    ]);
    await expect(connectFreshLocalGateway()).resolves.toEqual({
      displayLabel: 'This Mac',
      gatewayId: 'local',
      vaultId: 'personal',
    });
    expect(window.CentraidApi.setActiveVault).toHaveBeenCalledWith({ vaultId: 'personal' });
  });

  it('connectFreshLocalGateway surfaces an unreachable gateway', async () => {
    listVaults.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(connectFreshLocalGateway()).rejects.toThrow(/ECONNREFUSED/);
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
