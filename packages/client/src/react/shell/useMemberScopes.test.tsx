import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listAppScopes = vi.fn();
const listVaults = vi.fn();
vi.mock('../../gateway-client.js', () => ({
  listAppScopes: () => listAppScopes(),
  listVaults: () => listVaults(),
}));

let useMemberScopes: typeof import('./useMemberScopes.js').useMemberScopes;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  listAppScopes.mockReset();
  listVaults.mockReset();
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
    getGatewayAuth: () => Promise.resolve({ baseUrl: '', vaultId: 'a' }),
    getSettings: () =>
      Promise.resolve({
        activeGatewayId: 'local',
        activeGatewayLabel: 'This Mac',
        activeGatewayKind: 'local',
      }),
    onVaultChanged: () => () => {},
    onGatewayChanged: () => () => {},
  };
  ({ useMemberScopes } = await import('./useMemberScopes.js'));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

let ctl: ReturnType<typeof useMemberScopes>;
function Harness(): null {
  const value = useMemberScopes();
  // Published from a commit-time effect, not the render body — assigning to an
  // outer binding during render is a side effect.
  useEffect(() => {
    ctl = value;
  });
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

describe('useMemberScopes', () => {
  it('reads the member scope plane, keeping roles and own space first', async () => {
    listAppScopes.mockResolvedValue([
      { vaultId: 'a', label: 'Mine', role: 'admin', color: '#4E68DD' },
      { vaultId: 'b', label: 'Family', role: 'read' },
    ]);
    await mount();
    expect(ctl.loading).toBe(false);
    expect(ctl.scopes.map((s) => s.label)).toEqual(['Mine', 'Family']);
    expect(ctl.primary?.id).toBe('a');
    expect(ctl.scopes[1]?.canWrite).toBe(false);
    expect(ctl.defaultScopeId).toBe('a');
    expect(ctl.gatewayLabel).toBe('This Mac');
    expect(ctl.gatewayKind).toBe('local');
    expect(listVaults).not.toHaveBeenCalled();
  });

  it('falls back to the vault list when the gateway mounts no scopes plane', async () => {
    listAppScopes.mockResolvedValue(undefined);
    listVaults.mockResolvedValue([{ vaultId: 'only', name: 'Solo', ownerPartyId: 'p1' }]);
    await mount();
    expect(ctl.scopes).toHaveLength(1);
    // A gateway without the member layer is a single-owner world: the one
    // person there owns what they can see.
    expect(ctl.scopes[0]).toMatchObject({ id: 'only', label: 'Solo', role: 'admin' });
  });

  it('falls back to the first scope when nothing names a default pointer', async () => {
    (
      globalThis as unknown as { CentraidApi: { getGatewayAuth: () => Promise<unknown> } }
    ).CentraidApi.getGatewayAuth = () => Promise.resolve({ baseUrl: '' });
    listAppScopes.mockResolvedValue([{ vaultId: 'first', label: 'First', role: 'admin' }]);
    await mount();
    expect(ctl.defaultScopeId).toBe('first');
  });

  it('degrades to an empty, non-crashing registry when both sources fail', async () => {
    listAppScopes.mockRejectedValue(new Error('offline'));
    listVaults.mockRejectedValue(new Error('offline'));
    await mount();
    expect(ctl.loading).toBe(false);
    expect(ctl.scopes).toEqual([]);
    expect(ctl.primary).toBeUndefined();
  });
});
