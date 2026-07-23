import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../gateway-client.js', () => ({
  getUserPrefs: () => Promise.resolve({}),
  saveUserPrefs: () => Promise.resolve(undefined),
  listApps: () => Promise.resolve([{ id: 'todos', name: 'Todos', kind: 'app' }]),
  listAutomations: () => Promise.resolve([]),
  listAutomationRuns: () => Promise.resolve([]),
  getInsightsSummary: () =>
    Promise.resolve({
      kpis: {
        totalTokens: 0,
        totalCostUsd: 0,
        agentReportedCostUsd: 0,
        estimatedCostUsd: 0,
        forecastCostUsd: 0,
        generations: 0,
        retries: 0,
        failedRuns: 0,
        failedCostUsd: 0,
        appsTouched: 0,
        unpricedRuns: 0,
        unreportedRuns: 0,
      },
      daily: [],
      bySource: [],
      byRunner: [],
      byModel: [],
      recent: [],
      windowDays: 30,
      generatedAt: 0,
    }),
  getBlocking: () => Promise.resolve({ outbox: [], needsAuth: [], parked: [], scopeRequests: [] }),
}));

// The renderer's client-local store is a plain module now; back it with an
// in-memory Map so the hooks read/write deterministically (vi.hoisted lets the
// mock factory close over `store` despite mock hoisting).
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

beforeEach(
  async () => {
    store.clear();
    store.set('home.userApps', [{ id: 'todos', name: 'Todos', iconKey: 'Todo', color: '#123' }]);
    // Ambient globals the real tileVisualFromListing (via useShellApps) probes.
    (globalThis as unknown as { Icon: unknown }).Icon = { Todo: () => '', Sparkle: () => '' };
    (globalThis as unknown as { ICON_PALETTE: unknown }).ICON_PALETTE = { violet: '#7C5BD9' };
    // The App boot effect subscribes to gateway/vault change broadcasts.
    // `getSettings` feeds useBuilderEnabled (#434) — default omits builderEnabled,
    // so the builder stays hidden unless a test overrides it before mounting.
    (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = {
      onGatewayChanged: () => {},
      onVaultChanged: () => {},
      getSettings: () => Promise.resolve({}),
    };
    // Home's buildHomeAppItems asks the tokens bridge for each tile's finish.
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
  });
  return host;
}

describe('App root', () => {
  it('renders the chrome frame with the app in the sidebar, opening on Home', async () => {
    const el = await mount();
    expect(el.querySelector('.window')).not.toBeNull();
    expect(el.textContent).toContain('Todos');
    expect(el.textContent).toContain('Apps · 1');
    const activeHome = el.querySelector('[data-active="true"]');
    expect(activeHome?.textContent).toContain('Home');
  });

  it('navigates to Insights via the sidebar and highlights it', async () => {
    const el = await mount();
    const insightsBtn = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('Insights'),
    ) as HTMLButtonElement;
    await act(async () => {
      insightsBtn.click();
    });
    const active = el.querySelector('[data-active="true"]');
    expect(active?.textContent).toContain('Insights');
    // Insights route mounts its own dashboard (a main-scroll body) once loaded.
    await act(async () => {
      await Promise.resolve();
    });
    expect(el.querySelector('.mainScroll')).not.toBeNull();
  });

  it('renders the Starred empty state natively', async () => {
    const el = await mount();
    const starredBtn = [...el.querySelectorAll('.sbItem')].find((b) =>
      b.textContent?.includes('Starred'),
    ) as HTMLButtonElement;
    await act(async () => {
      starredBtn.click();
    });
    expect(el.textContent).toContain('Nothing starred yet');
    expect(el.querySelector('.pageHead')?.textContent).toContain('Starred');
  });

  it('hides every builder entry point by default (#434 builder off)', async () => {
    const el = await mount();
    // No "Build new" in the sidebar and no composer hero on Home.
    expect(el.textContent).not.toContain('Build new');
    expect(el.querySelector('.composerInput')).toBeNull();
    // The ⌘K palette lists the app but no "Build a new app…" create row.
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    });
    const dialog = el.querySelector('[aria-label="Command palette"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Todos');
    expect(dialog?.textContent).not.toContain('Build a new app…');
  });

  it('reveals builder entry points when builderEnabled is set (#434 builder on)', async () => {
    (globalThis as unknown as { CentraidApi: { getSettings: unknown } }).CentraidApi.getSettings =
      () => Promise.resolve({ builderEnabled: true });
    const el = await mount();
    // useBuilderEnabled resolves getSettings() a tick after first paint.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(el.textContent).toContain('Build new');
    expect(el.querySelector('.composerInput')).not.toBeNull();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
    });
    const dialog = el.querySelector('[aria-label="Command palette"]');
    expect(dialog?.textContent).toContain('Build a new app…');
  });

  it('binds the sidebar toggle to the appearance pref', async () => {
    const el = await mount();
    expect(el.querySelector<HTMLElement>('.window')?.dataset.sidebar).toBe('open');
    const toggle = el.querySelector('.tlSide [aria-label="Hide sidebar"]') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    expect(el.querySelector<HTMLElement>('.window')?.dataset.sidebar).toBe('closed');
    expect(store.get('appearance')).toMatchObject({ sidebarOpen: false });
  });
});

describe('BuilderRouteRedirect (#434)', () => {
  it('replaces a stale builder route with Home on mount', async () => {
    const { BuilderRouteRedirect } = await import('./App.js');
    const replace = vi.fn();
    const nav = { replace } as unknown as Parameters<typeof BuilderRouteRedirect>[0]['nav'];
    const el = document.createElement('div');
    document.body.append(el);
    const r = createRoot(el);
    await act(async () => {
      r.render(<BuilderRouteRedirect nav={nav} />);
    });
    expect(replace).toHaveBeenCalledWith({ kind: 'home' });
    act(() => r.unmount());
    el.remove();
  });
});
