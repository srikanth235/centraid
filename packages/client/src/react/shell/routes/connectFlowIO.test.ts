/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Connect flow IO error folding (issue #545 B8).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listVaults = vi.fn<typeof import('../../../gateway-client.js').listVaults>();
const connectGateway = vi.fn<typeof import('./gatewayModals.js').connectGateway>();
const friendlyGatewayError = vi.fn<typeof import('./gatewayModals.js').friendlyGatewayError>(
  (error, message) => message || error,
);

vi.mock(import('../../../gateway-client.js'), () => ({
  listVaults: () => listVaults(),
}));

vi.mock(import('./gatewayModals.js'), () => ({
  connectGateway: (input) => connectGateway(input),
  friendlyGatewayError: (error, message) => friendlyGatewayError(error, message),
}));

import {
  commitConnectFlow,
  connectFreshLocalGateway,
  loadLocalVaults,
  runConnectivityTest,
} from './connectFlowIO.js';

describe('connectFlowIO scenarios', () => {
  beforeEach(() => {
    listVaults.mockReset();
    connectGateway.mockReset();
    window.CentraidApi = {
      getSettings: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ activeGatewayId: 'local' }),
      setActiveGateway: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
      createVault: vi
        .fn<(...args: unknown[]) => unknown>()
        .mockResolvedValue({ vaultId: 'v-new', name: 'New' }),
      setActiveVault: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(undefined),
    } as unknown as typeof window.CentraidApi;
  });

  describe(runConnectivityTest, () => {
    it('fails closed when bridge is missing', async () => {
      window.CentraidApi = {} as typeof window.CentraidApi;
      const report = await runConnectivityTest({ method: 'gateway', url: 'http://x' } as never);
      expect(report.ok).toBe(false);
      expect(report.error).toBe('unavailable');
    });

    it('folds bridge throw into unreachable reach stage', async () => {
      window.CentraidApi = {
        testGatewayConnection: vi
          .fn<(...args: unknown[]) => unknown>()
          .mockRejectedValue(new Error('ECONNREFUSED')),
      } as unknown as typeof window.CentraidApi;
      const report = await runConnectivityTest({ method: 'gateway', url: 'http://x' } as never);
      expect(report.ok).toBe(false);
      expect(report.error).toBe('unreachable');
      expect(report.stages?.[0]?.detail).toMatch(/ECONNREFUSED/u);
    });

    it('returns bridge report on success', async () => {
      const ok = {
        ok: true,
        stages: [{ id: 'reach', label: 'Reach gateway', status: 'ok' }],
        vaults: [],
      };
      window.CentraidApi = {
        testGatewayConnection: vi.fn<(...args: unknown[]) => unknown>().mockResolvedValue(ok),
      } as unknown as typeof window.CentraidApi;
      await expect(
        runConnectivityTest({ method: 'gateway', url: 'http://x' } as never),
      ).resolves.toStrictEqual(ok);
    });
  });

  describe('loadLocalVaults / commitConnectFlow', () => {
    it('maps listVaults rows on a successful read', async () => {
      listVaults.mockResolvedValue([
        { color: '#fff', icon: 'Folder', name: 'Home', ownerPartyId: 'party-1', vaultId: 'v1' },
      ]);
      await expect(loadLocalVaults()).resolves.toStrictEqual({
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
      expect(result.ok === false && result.message).toMatch(/down/u);
    });

    it('reports a gateway with no vault route as a failure too', async () => {
      listVaults.mockResolvedValue(undefined);
      expect((await loadLocalVaults()).ok).toBe(false);
    });

    it('an empty-but-readable registry is a success with zero vaults', async () => {
      listVaults.mockResolvedValue([]);
      await expect(loadLocalVaults()).resolves.toStrictEqual({ ok: true, vaults: [] });
    });

    it('connectFreshLocalGateway addresses the auto-founded Personal vault', async () => {
      listVaults.mockResolvedValue([
        { ownerPartyId: 'party-1', vaultId: 'shared', name: 'Shared' },
        { ownerPartyId: 'party-1', vaultId: 'personal', name: 'Personal' },
      ]);
      await expect(connectFreshLocalGateway()).resolves.toStrictEqual({
        displayLabel: 'This Mac',
        gatewayId: 'local',
        vaultId: 'personal',
      });
      expect(window.CentraidApi.setActiveVault).toHaveBeenCalledWith({ vaultId: 'personal' });
    });

    it('connectFreshLocalGateway surfaces an unreachable gateway', async () => {
      listVaults.mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(connectFreshLocalGateway()).rejects.toThrow(/ECONNREFUSED/u);
    });

    it('rejects commit without a method or vault choice', async () => {
      await expect(commitConnectFlow({ method: null } as never)).rejects.toThrow(
        /No connection method/u,
      );
      await expect(
        commitConnectFlow({ method: 'local', vaultChoice: null } as never),
      ).rejects.toThrow(/Pick or create/u);
    });
  });
});
