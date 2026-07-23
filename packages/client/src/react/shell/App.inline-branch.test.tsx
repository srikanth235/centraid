import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The `app` route branches to the inline route for any registered inline id —
// regardless of builder state (the builder is a separate `kind: 'builder'`
// route, so enabling it must NOT knock blueprint apps back to the iframe);
// everything else keeps the (iframe) AppViewRoute. Mock both route components
// to identifiable markers and the registry so the branch decision is observable
// without mounting the real inline machinery.
vi.mock('./routes/InlineAppRoute.js', () => ({
  default: () => <div data-testid="inline-marker">INLINE</div>,
}));
vi.mock('./routes/AppViewRoute.js', () => ({
  default: () => <div data-testid="appview-marker">APPVIEW</div>,
}));
vi.mock('./routes/inlineApps.js', () => ({
  inlineAppLoader: (appId: string) =>
    appId === 'tasks' ? () => Promise.resolve({ default: {} }) : undefined,
  isInlineApp: (appId: string) => appId === 'tasks',
}));

vi.mock('../../gateway-client.js', () => ({
  getUserPrefs: () => Promise.resolve({}),
  saveUserPrefs: () => Promise.resolve(undefined),
  listApps: () =>
    Promise.resolve([
      { id: 'tasks', name: 'Tasks', kind: 'app' },
      { id: 'todos', name: 'Todos', kind: 'app' },
    ]),
  listAutomations: () => Promise.resolve([]),
  listAutomationRuns: () => Promise.resolve([]),
  getBlocking: () => Promise.resolve({ outbox: [], needsAuth: [], parked: [], scopeRequests: [] }),
}));

const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock('./store.js', () => ({
  Store: {
    get: <T,>(k: string, d: T): T => (store.has(k) ? (store.get(k) as T) : d),
    set: (k: string, v: unknown) => store.set(k, v),
  },
}));

let App: typeof import('./App.js').default;
let root: Root | null = null;
let host: HTMLElement | null = null;

function openApp(id: string): void {
  (window as unknown as { Centraid: { openApp: (id: string) => void } }).Centraid.openApp(id);
}

beforeEach(
  async () => {
    store.clear();
    store.set('home.userApps', [
      { id: 'tasks', name: 'Tasks', iconKey: 'Todo', color: '#123' },
      { id: 'todos', name: 'Todos', iconKey: 'Todo', color: '#456' },
    ]);
    (globalThis as unknown as { Icon: unknown }).Icon = { Todo: () => '', Sparkle: () => '' };
    (globalThis as unknown as { ICON_PALETTE: unknown }).ICON_PALETTE = { violet: '#7C5BD9' };
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      onGatewayChanged: () => {},
      onVaultChanged: () => {},
      getSettings: () => Promise.resolve({}),
    };
    (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
      tileFinish: () => ({ background: '#111', boxShadow: 'none', glyphColor: '#fff' }),
    };
    ({ default: App } = await import('./App.js'));
  },
  // The affected-package gate transforms six packages concurrently. Keep the
  // first App graph import bounded without inheriting Vitest's 10s hook ceiling.
  20_000,
);

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function mount(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return host;
}

describe('App — inline vs iframe app route (#505)', () => {
  it('routes a registered inline id to InlineAppRoute', async () => {
    const el = await mount();
    await act(async () => openApp('tasks'));
    expect(el.querySelector('[data-testid="inline-marker"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="appview-marker"]')).toBeNull();
  });

  it('routes an unregistered id to the iframe AppViewRoute', async () => {
    const el = await mount();
    await act(async () => openApp('todos'));
    expect(el.querySelector('[data-testid="appview-marker"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="inline-marker"]')).toBeNull();
  });

  it('keeps a registered inline id on InlineAppRoute even while the builder is enabled', async () => {
    // Enabling the builder must NOT knock blueprint apps back to the iframe: the
    // builder is a separate route, and a blueprint's code is never edited in
    // place, so the inline path stays correct and offline-capable.
    (globalThis as unknown as { CentraidApi: { getSettings: unknown } }).CentraidApi.getSettings =
      () => Promise.resolve({ builderEnabled: true });
    const el = await mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => openApp('tasks'));
    expect(el.querySelector('[data-testid="inline-marker"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="appview-marker"]')).toBeNull();
  });
});
