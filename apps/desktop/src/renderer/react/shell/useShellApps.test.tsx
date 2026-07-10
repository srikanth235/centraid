import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listApps = vi.fn();
vi.mock('../../gateway-client.js', () => ({
  listApps: () => listApps(),
  listVaults: () => Promise.resolve([]),
}));
// tileVisualFromListing/colorForIcon are pure — use the real ones.
// The client-local store is a plain module now; back it with an in-memory Map.
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./store.js', () => ({
  Store: {
    get: <T,>(k: string, d: T): T => (store.has(k) ? (store.get(k) as T) : d),
    set: (k: string, v: unknown) => store.set(k, v),
  },
}));

let useShellApps: typeof import('./useShellApps.js').useShellApps;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(async () => {
  store.clear();
  // tileVisualFromListing (real, pure) probes the ambient Icon registry to
  // validate an icon key — stub it with the keys the fixtures use.
  (globalThis as unknown as { Icon: unknown }).Icon = {
    Todo: () => '',
    Habit: () => '',
    Sparkle: () => '',
  };
  (globalThis as unknown as { ICON_PALETTE: unknown }).ICON_PALETTE = {
    teal: '#3EC8B4',
    violet: '#7C5BD9',
    blue: '#4950F6',
  };
  listApps.mockReset();
  ({ useShellApps } = await import('./useShellApps.js'));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  delete (window as { CentraidApi?: unknown }).CentraidApi;
});

let ctl: ReturnType<typeof useShellApps>;
function Harness(): null {
  ctl = useShellApps();
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

describe('useShellApps', () => {
  it('derives drafts from the listing, excluding pinned + automation entries', async () => {
    store.set('home.userApps', [{ id: 'todos', name: 'Todos', iconKey: 'Todo', color: '#1' }]);
    listApps.mockResolvedValue([
      { id: 'todos', name: 'Todos', kind: 'app' },
      { id: 'wip', name: 'WIP', kind: 'app', hasIndex: true },
      { id: 'auto1', name: 'Cron', kind: 'automation' },
    ]);
    await mount();
    expect(ctl.drafts.map((d) => d.id)).toEqual(['wip']);
    expect(ctl.userApps.map((a) => a.id)).toEqual(['todos']);
  });

  it('prunes orphan pins whose app no longer exists on the gateway', async () => {
    store.set('home.userApps', [
      { id: 'todos', name: 'Todos', iconKey: 'Todo', color: '#1' },
      { id: 'gone', name: 'Gone', iconKey: 'Todo', color: '#2' },
    ]);
    listApps.mockResolvedValue([{ id: 'todos', name: 'Todos', kind: 'app' }]);
    await mount();
    expect(ctl.userApps.map((a) => a.id)).toEqual(['todos']);
    expect((store.get('home.userApps') as unknown[]).length).toBe(1);
  });

  it('overlays tile identity from the listing app.json', async () => {
    store.set('home.userApps', [{ id: 'todos', name: 'Todos', iconKey: 'Todo', color: '#old' }]);
    listApps.mockResolvedValue([
      { id: 'todos', name: 'Todos', kind: 'app', iconKey: 'Habit', colorKey: 'teal' },
    ]);
    await mount();
    expect(ctl.userApps[0]?.iconKey).toBe('Habit');
  });

  it('overlays a renamed app.json name/description onto the cached pin', async () => {
    // Reproduces the Home-tile-never-updates-after-rename bug: updateAppMeta
    // only writes the new name to the gateway's app.json — the Home pin
    // cached in the Store must pick it up via this reconciliation, since
    // nothing else calls setUserApps() after a rename.
    store.set('home.userApps', [
      { id: 'agenda', name: 'Agenda', desc: 'Old desc', iconKey: 'Todo', color: '#old' },
    ]);
    listApps.mockResolvedValue([
      { id: 'agenda', name: 'Agenda Renamed', description: 'New desc', kind: 'app' },
    ]);
    await mount();
    expect(ctl.userApps[0]?.name).toBe('Agenda Renamed');
    expect(ctl.userApps[0]?.desc).toBe('New desc');
  });

  it('empties drafts when the listing fetch fails', async () => {
    listApps.mockRejectedValue(new Error('offline'));
    await mount();
    expect(ctl.drafts).toEqual([]);
  });

  it('a vault switch parks the outgoing vault’s pins instead of pruning them', async () => {
    // Reproduces the DRAFT-demotion bug: pins live in a non-vault-scoped
    // store, so a switch to an empty vault made every pin look orphaned,
    // and the prune destroyed them permanently.
    const api = (vaultId: string) => ({ getGatewayAuth: async () => ({ baseUrl: '', vaultId }) });
    (window as unknown as { CentraidApi: unknown }).CentraidApi = api('A');
    store.set('home.userApps', [{ id: 'notes', name: 'Notes', iconKey: 'Todo', color: '#1' }]);
    listApps.mockResolvedValue([{ id: 'notes', name: 'Notes', kind: 'app' }]);
    await mount();
    expect(ctl.userApps.map((a) => a.id)).toEqual(['notes']);

    // Switch to empty vault B: Home empties, but A's pins are parked.
    (window as unknown as { CentraidApi: unknown }).CentraidApi = api('B');
    listApps.mockResolvedValue([]);
    await act(async () => ctl.refresh());
    expect(ctl.userApps).toEqual([]);

    // Back to A: the pin is restored, not demoted to a draft.
    (window as unknown as { CentraidApi: unknown }).CentraidApi = api('A');
    listApps.mockResolvedValue([{ id: 'notes', name: 'Notes', kind: 'app' }]);
    await act(async () => ctl.refresh());
    expect(ctl.userApps.map((a) => a.id)).toEqual(['notes']);
    expect(ctl.drafts).toEqual([]);
  });

  it('setUserApps persists to the Store', async () => {
    listApps.mockResolvedValue([]);
    await mount();
    await act(async () => {
      ctl.setUserApps([
        { id: 'x', name: 'X', iconKey: 'Todo', color: '#3' } as unknown as UserAppMeta,
      ]);
    });
    expect((store.get('home.userApps') as UserAppMeta[])[0]?.id).toBe('x');
  });
});
