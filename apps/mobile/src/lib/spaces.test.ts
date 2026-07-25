/**
 * Spaces owner (issue #545 C5) — device-local (gateway, vault) registry.
 */
import { describe, expect, it, vi } from 'vitest';

const storeMem = new Map<string, unknown>();
const secureMem = new Map<string, string>();

vi.mock('../storage', () => ({
  Store: {
    get<T>(key: string, fallback: T): T {
      return storeMem.has(key) ? (storeMem.get(key) as T) : fallback;
    },
    set<T>(key: string, value: T): void {
      storeMem.set(key, value);
    },
    async hydrate<T>(key: string, fallback: T): Promise<T> {
      if (!storeMem.has(key)) storeMem.set(key, fallback);
      return storeMem.get(key) as T;
    },
  },
}));

vi.mock('./secure-storage', () => ({
  async hydrateSecure(key: string, fallback = ''): Promise<string> {
    return secureMem.has(key) ? (secureMem.get(key) as string) : fallback;
  },
  async setSecure(key: string, value: string): Promise<void> {
    secureMem.set(key, value);
  },
  getSecure(key: string, fallback = ''): string {
    return secureMem.has(key) ? (secureMem.get(key) as string) : fallback;
  },
}));

async function loadSpaces() {
  vi.resetModules();
  storeMem.clear();
  secureMem.clear();
  return import('./spaces');
}

describe('Spaces registry', () => {
  it('adds a space, projects the active slot, and lists it', async () => {
    const spaces = await loadSpaces();
    const space = await spaces.addSpace({
      gatewayId: 'gw-1',
      desktopName: 'Mac mini',
      deviceId: 'dev-1',
      vaultId: 'vault-a',
      ticket: 'pair-ticket',
      vaultName: 'Personal',
    });
    expect(space.gatewayId).toBe('gw-1');
    expect(spaces.listSpaces()).toHaveLength(1);
    expect(spaces.getActiveSpace()?.id).toBe(space.id);
    expect(spaces.getActiveVaultId()).toBe('vault-a');
    expect(secureMem.get(spaces.LINK_TICKET_KEY)).toBe('pair-ticket');
  });

  it('upserts the same (gateway, vault) tuple instead of duplicating', async () => {
    const spaces = await loadSpaces();
    const first = await spaces.addSpace({
      gatewayId: 'gw-1',
      desktopName: 'Desk',
      deviceId: 'd1',
      vaultId: 'v1',
      ticket: 't1',
    });
    const second = await spaces.addSpace({
      gatewayId: 'gw-1',
      desktopName: 'Desk',
      deviceId: 'd1',
      vaultId: 'v1',
      ticket: 't2',
      vaultName: 'Home',
    });
    expect(second.id).toBe(first.id);
    expect(spaces.listSpaces()).toHaveLength(1);
    expect(spaces.getActiveSpace()?.vaultName).toBe('Home');
  });

  it('switches active space and notifies subscribers', async () => {
    const spaces = await loadSpaces();
    const a = await spaces.addSpace({
      gatewayId: 'gw-a',
      desktopName: 'A',
      deviceId: 'd',
      vaultId: 'va',
      ticket: 'ta',
    });
    const b = await spaces.addSpace({
      gatewayId: 'gw-b',
      desktopName: 'B',
      deviceId: 'd',
      vaultId: 'vb',
      ticket: 'tb',
    });
    expect(spaces.getActiveSpace()?.id).toBe(b.id);
    let ticks = 0;
    const unsub = spaces.subscribeSpaces(() => {
      ticks += 1;
    });
    await spaces.setActiveSpace(a.id);
    expect(spaces.getActiveSpace()?.id).toBe(a.id);
    expect(ticks).toBeGreaterThanOrEqual(1);
    unsub();
  });

  it('forgets a space and falls back when it was active', async () => {
    const spaces = await loadSpaces();
    const a = await spaces.addSpace({
      gatewayId: 'gw-a',
      desktopName: 'A',
      deviceId: 'd',
      vaultId: 'va',
      ticket: 'ta',
    });
    const b = await spaces.addSpace({
      gatewayId: 'gw-b',
      desktopName: 'B',
      deviceId: 'd',
      vaultId: 'vb',
      ticket: 'tb',
    });
    await spaces.removeSpace(b.id);
    expect(spaces.listSpaces().map((s) => s.id)).toEqual([a.id]);
    expect(spaces.getActiveSpace()?.id).toBe(a.id);
    await spaces.removeSpace(a.id);
    expect(spaces.listSpaces()).toEqual([]);
    expect(spaces.getActiveSpace()).toBeUndefined();
    expect(spaces.getActiveVaultId()).toBe('');
  });
});
