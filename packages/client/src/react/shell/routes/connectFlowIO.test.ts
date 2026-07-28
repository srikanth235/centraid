/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Connect flow IO error folding (issue #545 B8).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listVaults = vi.fn<typeof import('../../../gateway-client.js').listVaults>();
const connectGateway =
  vi.fn<(...args: unknown[]) => Promise<import('./gatewayModals.js').GatewayConnectResult>>();
const friendlyGatewayError = vi.fn<(e: unknown) => string>((e) =>
  e instanceof Error ? e.message : String(e),
);

vi.mock(import('../../../gateway-client.js'), () => ({
  listVaults: () => listVaults(),
}));

vi.mock(import('./gatewayModals.js'), () => ({
  connectGateway: (...a: unknown[]) => connectGateway(...a),
  friendlyGatewayError: (e: unknown) => friendlyGatewayError(e),
}));

import {
  commitConnectFlow,
  type ConnectFlowBridge,
  loadLocalVaults,
  runConnectivityTest,
} from './connectFlowIO.js';

describe('connectFlowIO', () => {
  beforeEach(() => {
    listVaults.mockReset();
    connectGateway.mockReset();
    window.CentraidApi = {
      getSettings: vi
        .fn<() => Promise<{ activeGatewayId: string }>>()
        .mockResolvedValue({ activeGatewayId: 'local' }),
      setActiveGateway: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      createVault: vi
        .fn<() => Promise<{ vaultId: string; name: string }>>()
        .mockResolvedValue({ vaultId: 'v-new', name: 'New' }),
      setActiveVault: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    } as unknown as typeof window.CentraidApi;
  });

  describe(runConnectivityTest, () => {
    it('fails closed when bridge is missing', async () => {
      window.CentraidApi = {} as typeof window.CentraidApi;
      const report = await runConnectivityTest({
        method: 'gateway',
        url: 'http://x',
      } as never);
      expect(report.ok).toBe(false);
      expect(report.error).toBe('unavailable');
    });

    it('folds bridge throw into unreachable reach stage', async () => {
      window.CentraidApi = {
        testGatewayConnection: vi
          .fn<ConnectFlowBridge['testGatewayConnection']>()
          .mockRejectedValue(new Error('ECONNREFUSED')),
      } as unknown as typeof window.CentraidApi;
      const report = await runConnectivityTest({
        method: 'gateway',
        url: 'http://x',
      } as never);
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
        testGatewayConnection: vi.fn<() => Promise<typeof ok>>().mockResolvedValue(ok),
      } as unknown as typeof window.CentraidApi;
      await expect(
        runConnectivityTest({ method: 'gateway', url: 'http://x' } as never),
      ).resolves.toStrictEqual(ok);
    });
  });

  describe('loadLocalVaults / commitConnectFlow', () => {
    it('maps listVaults rows and tolerates failure', async () => {
      listVaults.mockResolvedValue([
        {
          vaultId: 'v1',
          name: 'Home',
          ownerPartyId: 'party-1',
          color: '#fff',
          icon: 'Folder',
        },
      ]);
      await expect(loadLocalVaults()).resolves.toStrictEqual([
        { vaultId: 'v1', name: 'Home', color: '#fff', icon: 'Folder' },
      ]);
      listVaults.mockRejectedValue(new Error('down'));
      await expect(loadLocalVaults()).resolves.toStrictEqual([]);
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
