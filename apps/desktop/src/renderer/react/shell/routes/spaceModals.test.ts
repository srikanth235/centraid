import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSpace, deleteSpace, saveSpace } from './spaceModals.js';

const updateVault = vi.fn((_input?: unknown) => Promise.resolve({}));
// `vi.mock` is hoisted above the imports by vitest, so the gateway stub lands
// before spaceModals.js pulls gateway-client-core's load-time side-effect.
vi.mock('../../../gateway-client.js', () => ({
  listVaults: () =>
    Promise.resolve([
      { vaultId: 'v1', name: 'Work', color: '#222', icon: 'Folder', blurb: 'real' },
    ]),
  updateVault: (a: unknown) => updateVault(a),
}));

const createVault = vi.fn(() => Promise.resolve({ vaultId: 'new1' }));
const deleteVault = vi.fn(() => Promise.resolve({ deleted: true }));
const setActiveVault = vi.fn(() => Promise.resolve());

beforeEach(() => {
  updateVault.mockClear();
  createVault.mockClear();
  deleteVault.mockClear();
  setActiveVault.mockClear();
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    createVault,
    deleteVault,
    setActiveVault,
  };
});

describe('spaceModals', () => {
  it('createSpace creates a vault, paints it, and switches to it', async () => {
    await createSpace({ name: 'Play', icon: 'Star', color: '#0f0', blurb: '' });
    expect(createVault).toHaveBeenCalledWith({ name: 'Play' });
    expect(updateVault).toHaveBeenCalledWith({
      vaultId: 'new1',
      color: '#0f0',
      icon: 'Star',
      blurb: null,
    });
    expect(setActiveVault).toHaveBeenCalledWith({ vaultId: 'new1' });
  });

  it('saveSpace renames the vault without switching', async () => {
    await saveSpace('v1', { name: 'Work HQ', icon: 'Folder', color: '#111', blurb: 'hq' });
    expect(updateVault).toHaveBeenCalledWith({
      vaultId: 'v1',
      name: 'Work HQ',
      color: '#111',
      icon: 'Folder',
      blurb: 'hq',
    });
    expect(setActiveVault).not.toHaveBeenCalled();
  });

  it('deleteSpace removes the vault', async () => {
    await deleteSpace('v1');
    expect(deleteVault).toHaveBeenCalledWith({ vaultId: 'v1' });
  });
});
