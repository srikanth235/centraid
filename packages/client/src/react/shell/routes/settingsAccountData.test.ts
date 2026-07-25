/* oxlint-disable import/first -- vi.mock is hoisted; subject imports intentionally follow */
/**
 * Settings account / space data layer (issue #545 B8).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const listVaults = vi.fn();
const vaultStatus = vi.fn();
const vaultImportsList = vi.fn();
const vaultConnections = vi.fn();
const vaultImportDiscard = vi.fn();

vi.mock('../../../gateway-client.js', () => ({
  listVaults: () => listVaults(),
  vaultStatus: () => vaultStatus(),
  vaultImportsList: () => vaultImportsList(),
  vaultConnections: () => vaultConnections(),
  vaultImportDiscard: (id: string) => vaultImportDiscard(id),
  vaultImportPublish: vi.fn(),
  vaultImportRows: vi.fn(),
  vaultImportStage: vi.fn(),
  vaultConnectionSetStatus: vi.fn(),
}));

import { importCallbacks, loadActiveSpaceData, phoneCallbacks } from './settingsAccountData.js';

beforeEach(() => {
  listVaults.mockReset();
  vaultStatus.mockReset();
  vaultImportsList.mockReset();
  vaultConnections.mockReset();
  window.CentraidApi = {
    getGatewayAuth: vi.fn().mockResolvedValue({ vaultId: 'v1' }),
    beginPhonePairing: vi.fn(),
    onPhonePaired: vi.fn(() => () => undefined),
    cancelPhonePairing: vi.fn(),
    getPhoneLinkStatus: vi.fn(),
    revokePhoneDevice: vi.fn(),
  } as unknown as typeof window.CentraidApi;
});

describe('loadActiveSpaceData', () => {
  it('returns null when no active vault is found', async () => {
    listVaults.mockResolvedValue([]);
    await expect(loadActiveSpaceData()).resolves.toBeNull();
  });

  it('maps the active vault and deletable when more than one space exists', async () => {
    listVaults.mockResolvedValue([
      { vaultId: 'v1', name: 'Home', icon: 'Folder', color: '#111', blurb: 'b' },
      { vaultId: 'v2', name: 'Work', icon: 'Briefcase', color: '#222' },
    ]);
    await expect(loadActiveSpaceData()).resolves.toEqual({
      vaultId: 'v1',
      name: 'Home',
      icon: 'Folder',
      color: '#111',
      blurb: 'b',
      deletable: true,
    });
  });

  it('marks the sole vault non-deletable', async () => {
    listVaults.mockResolvedValue([{ vaultId: 'v1', name: 'Only', icon: 'Folder', color: '#111' }]);
    const data = await loadActiveSpaceData();
    expect(data?.deletable).toBe(false);
  });
});

describe('phoneCallbacks / importCallbacks', () => {
  it('phone loadStatus maps devices; revoke folds missing result to false', async () => {
    const toast = vi.fn();
    const phone = phoneCallbacks(toast);
    (window.CentraidApi.getPhoneLinkStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      running: true,
      error: null,
      devices: [
        {
          deviceId: 'd1',
          name: 'Phone',
          platform: 'ios',
          endpointId: 'e1',
          addedAt: 1,
        },
      ],
    });
    await expect(phone.loadStatus()).resolves.toMatchObject({
      running: true,
      devices: [{ deviceId: 'd1', name: 'Phone' }],
    });

    (window.CentraidApi.revokePhoneDevice as ReturnType<typeof vi.fn>).mockResolvedValue({
      removed: true,
    });
    await expect(phone.revoke('d1')).resolves.toBe(true);
    (window.CentraidApi.revokePhoneDevice as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('x'),
    );
    await expect(phone.revoke('d1')).resolves.toBe(false);
  });

  it('import loadData returns null without vault status', async () => {
    const imp = importCallbacks(vi.fn());
    vaultStatus.mockRejectedValue(new Error('down'));
    await expect(imp.loadData()).resolves.toBeNull();
  });
});
