import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openSpaceModal, requestDeleteSpace } from './spaceModals.js';
import type { ProfileRowDTO } from '../../bridge.js';

const updateVault = vi.fn((_input?: unknown) => Promise.resolve({}));
// `vi.mock` is hoisted above the imports by vitest, so the gateway stub lands
// before spaceModals.js pulls gateway-client-core's load-time side-effect.
vi.mock('../../../gateway-client.js', () => ({
  listVaults: () => Promise.resolve([{ vaultId: 'v1', name: 'Work', color: '#111', icon: 'Folder', blurb: 'b' }]),
  updateVault: (a: unknown) => updateVault(a),
}));

let modalOpts: Record<string, (...a: unknown[]) => void> | null = null;
let deleteOpts: Record<string, (...a: unknown[]) => void> | null = null;
const createVault = vi.fn(() => Promise.resolve({ vaultId: 'new1' }));
const deleteVault = vi.fn(() => Promise.resolve({ deleted: true }));
const setActiveVault = vi.fn(() => Promise.resolve());

// The modal callbacks are fire-and-forget (they return void), so flush the
// async chain they kick off before asserting.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  modalOpts = null;
  deleteOpts = null;
  updateVault.mockClear();
  createVault.mockClear();
  deleteVault.mockClear();
  setActiveVault.mockClear();
  (globalThis as unknown as { Profiles: unknown }).Profiles = {
    PROFILE_COLORS: ['#abc'],
    DEFAULT_ICON: 'Folder',
    toast: vi.fn(),
    openModal: (o: Record<string, (...a: unknown[]) => void>) => {
      modalOpts = o;
      return { close: vi.fn() };
    },
    openDeleteDialog: (o: Record<string, (...a: unknown[]) => void>) => {
      deleteOpts = o;
      return { close: vi.fn() };
    },
  };
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    createVault,
    deleteVault,
    setActiveVault,
  };
});

const row: ProfileRowDTO = {
  active: false,
  color: '#111',
  icon: 'Folder',
  id: 'v1',
  name: 'Work',
  primordial: false,
  subLine: 'b',
};

describe('spaceModals', () => {
  it('add mode creates a vault, paints it, switches to it, and re-scopes home', async () => {
    const onChanged = vi.fn();
    const navigateHome = vi.fn();
    openSpaceModal('add', undefined, { onChanged, navigateHome });
    expect(modalOpts).not.toBeNull();
    modalOpts!.onCommit!({ name: 'Play', icon: 'Star', color: '#0f0', blurb: '' });
    await settle();
    expect(createVault).toHaveBeenCalledWith({ name: 'Play' });
    expect(updateVault).toHaveBeenCalledWith({
      vaultId: 'new1',
      color: '#0f0',
      icon: 'Star',
      blurb: null,
    });
    expect(setActiveVault).toHaveBeenCalledWith({ vaultId: 'new1' });
    expect(onChanged).toHaveBeenCalledOnce();
    expect(navigateHome).toHaveBeenCalledOnce();
  });

  it('edit mode renames the vault without switching', async () => {
    const onChanged = vi.fn();
    const navigateHome = vi.fn();
    openSpaceModal('edit', row, { onChanged, navigateHome });
    // listVaults resolves async to prefill the modal before openModal fires.
    await settle();
    expect(modalOpts).not.toBeNull();
    modalOpts!.onCommit!({ name: 'Work HQ', icon: 'Folder', color: '#111', blurb: 'hq' });
    await settle();
    expect(updateVault).toHaveBeenCalledWith({
      vaultId: 'v1',
      name: 'Work HQ',
      color: '#111',
      icon: 'Folder',
      blurb: 'hq',
    });
    expect(setActiveVault).not.toHaveBeenCalled();
    expect(navigateHome).not.toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it('delete confirms via the vanilla dialog then removes the vault', async () => {
    const onChanged = vi.fn();
    requestDeleteSpace(row, { onChanged, navigateHome: vi.fn() });
    expect(deleteOpts).not.toBeNull();
    deleteOpts!.onConfirm!();
    await settle();
    expect(deleteVault).toHaveBeenCalledWith({ vaultId: 'v1' });
    expect(onChanged).toHaveBeenCalledOnce();
  });
});
