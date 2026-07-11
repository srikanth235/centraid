import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listVaults = vi.fn();
vi.mock('../../gateway-client.js', () => ({ listVaults: () => listVaults() }));

let useActiveVault: typeof import('./useActiveVault.js').useActiveVault;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  listVaults.mockReset();
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    getGatewayAuth: () => Promise.resolve({ baseUrl: '', vaultId: 'a' }),
    setActiveVault: vi.fn(() => Promise.resolve({})),
    onVaultChanged: () => () => {},
    onGatewayChanged: () => () => {},
  };
  ({ useActiveVault } = await import('./useActiveVault.js'));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

let ctl: ReturnType<typeof useActiveVault>;
function Harness(): null {
  ctl = useActiveVault();
  return null;
}
async function mount(): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

describe('useActiveVault', () => {
  it('resolves the addressed vault against getGatewayAuth().vaultId', async () => {
    listVaults.mockResolvedValue([
      { vaultId: 'a', name: "Owner's vault", ownerPartyId: 'p1', color: '#4E68DD' },
      { vaultId: 'b', name: 'Work', ownerPartyId: 'p1', color: '#2EA098' },
    ]);
    await mount();
    expect(ctl.loading).toBe(false);
    expect(ctl.active?.name).toBe("Owner's vault");
    expect(ctl.vaults).toHaveLength(2);
  });

  it('falls back to the first vault when the gateway has no explicit pointer', async () => {
    (
      globalThis as unknown as { CentraidApi: { getGatewayAuth: () => Promise<unknown> } }
    ).CentraidApi.getGatewayAuth = () => Promise.resolve({ baseUrl: '' });
    listVaults.mockResolvedValue([{ vaultId: 'only', name: 'Solo', ownerPartyId: 'p1' }]);
    await mount();
    expect(ctl.active?.vaultId).toBe('only');
  });

  it('degrades to an empty, non-crashing registry when the fetch fails', async () => {
    listVaults.mockRejectedValue(new Error('offline'));
    await mount();
    expect(ctl.loading).toBe(false);
    expect(ctl.vaults).toEqual([]);
    expect(ctl.active).toBeUndefined();
  });

  it('switchVault calls setActiveVault with the target id', async () => {
    listVaults.mockResolvedValue([{ vaultId: 'a', name: 'A', ownerPartyId: 'p1' }]);
    await mount();
    act(() => ctl.switchVault('b'));
    expect(
      (globalThis as unknown as { CentraidApi: { setActiveVault: ReturnType<typeof vi.fn> } })
        .CentraidApi.setActiveVault,
    ).toHaveBeenCalledWith({ vaultId: 'b' });
  });
});
