import { act, type JSX, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InlineAppModule, InlineAppProps } from '@centraid/blueprints/apps/inline-types';
import InlineAppRoute from './InlineAppRoute.js';

const doFetch = vi.fn();

// Heavy shell + gateway deps stubbed to their inline-relevant surface.
vi.mock('../../../gateway-client.js', () => ({
  deleteApp: vi.fn(),
  updateAppMeta: vi.fn(),
  streamTurn: vi.fn(),
  createConversation: vi.fn(),
  vaultParked: vi.fn(async () => []),
  confirmVaultParked: vi.fn(),
}));
vi.mock('../../../gateway-client-core.js', () => ({
  auth: vi.fn(async () => ({ baseUrl: 'https://gw.test', token: 'tok' })),
  authHeaders: () => ({}),
  doFetch: (...args: unknown[]) => doFetch(...args),
  readJson: vi.fn(),
}));
vi.mock('../ShellFrame.js', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shell-frame">{children}</div>
  ),
}));
vi.mock('./AppSettingsController.js', () => ({ default: () => null }));
vi.mock('./templatesData.js', () => ({ loadAppTemplates: vi.fn(async () => []) }));
vi.mock('./appSettingsData.js', () => ({
  fetchAppKnobValues: vi.fn(async () => ({})),
  pushKnobToInlineRoot: vi.fn(),
}));
vi.mock('../actions.js', () => ({
  useShellActions: () => ({
    confirm: vi.fn(async () => true),
    enterBuilder: vi.fn(),
    openNewAppSheet: vi.fn(),
    showToast: vi.fn(),
    builderEnabled: false,
  }),
}));
vi.mock('../iconSvg.js', () => ({ iconSvg: () => '<svg></svg>' }));
vi.mock('../prompt.js', () => ({ openPrompt: vi.fn(async () => '') }));

const fakeSession = {
  read: vi.fn(),
  search: vi.fn(),
  write: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
};
vi.mock('../../../replica/shell-session.js', () => ({
  getReplicaShellSession: vi.fn(async () => fakeSession),
}));

const app = {
  id: 'tasks',
  name: 'Tasks',
  iconKey: 'Todo',
  color: '#123',
} as unknown as AppMetaResolvedType;
const nav = {
  navigate: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  canGoBack: false,
  canGoForward: false,
  route: { kind: 'app', id: 'tasks' },
} as never;
const prefs = { sidebarOpen: true, theme: 'dark', bgL: 5 } as never;

// A distinct appId per test — InlineAppRoute keys its module-level descriptor
// cache on (appId, attempt), so reusing an id would serve a prior test's chunk.
function routeEl(loader: () => Promise<{ default: InlineAppModule }>, appId: string): JSX.Element {
  return (
    <InlineAppRoute
      app={app}
      appId={appId}
      loader={loader}
      nav={nav}
      renderSidebar={() => null}
      prefs={prefs}
      onToggleSidebar={() => {}}
    />
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(el: JSX.Element): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(el);
  });
  // let the lazy descriptor + session promises settle through Suspense
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    // eslint-disable-next-line no-await-in-loop -- sequential microtask drains (#505)
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  doFetch.mockReset();
  fakeSession.read.mockReset();
  (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
    tileFinish: () => ({ background: '#111', boxShadow: 'none', glyphColor: '#fff' }),
  };
  (globalThis as unknown as { CentraidApi: unknown }).CentraidApi = { openAppFolder: vi.fn() };
  delete (window as { centraid?: unknown }).centraid;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** A Root that reads the board through window.centraid on mount. */
function makeApp(RootImpl: InlineAppModule['Root']): InlineAppModule {
  return {
    appId: 'tasks',
    changeTables: ['schedule.task'],
    queries: { board: { default: async () => ({ open: [{ task_id: 'a', title: 'Buy milk' }] }) } },
    Root: RootImpl,
  };
}

describe('InlineAppRoute', () => {
  it('renders the inline app and paints from the local replica with zero gateway fetches', async () => {
    function Root({ rootRef }: InlineAppProps): JSX.Element {
      const [label, setLabel] = useState('…');
      useEffect(() => {
        void (
          window as unknown as {
            centraid: { read: (o: unknown) => Promise<{ open: Array<{ title: string }> }> };
          }
        ).centraid
          .read({ query: 'board' })
          .then((res) => setLabel(res.open[0]?.title ?? 'empty'));
      }, []);
      return (
        <div ref={rootRef} data-testid="tasks-root">
          {label}
        </div>
      );
    }
    await mount(routeEl(async () => ({ default: makeApp(Root) }), 'tasks-render'));
    await flush();
    expect(host!.querySelector('[data-testid="tasks-root"]')?.textContent).toBe('Buy milk');
    // Offline first paint: no gateway tool route touched.
    expect(doFetch).not.toHaveBeenCalled();
    // window.centraid is installed for the app.
    expect((window as { centraid?: unknown }).centraid).toBeDefined();
  });

  it('tears down window.centraid on unmount', async () => {
    function Root({ rootRef }: InlineAppProps): JSX.Element {
      return <div ref={rootRef}>ok</div>;
    }
    await mount(routeEl(async () => ({ default: makeApp(Root) }), 'tasks-teardown'));
    expect((window as { centraid?: unknown }).centraid).toBeDefined();
    act(() => root?.unmount());
    root = null;
    expect((window as { centraid?: unknown }).centraid).toBeUndefined();
  });

  it('catches a failed chunk load and Retry re-imports + remounts', async () => {
    function Root({ rootRef }: InlineAppProps): JSX.Element {
      return (
        <div ref={rootRef} data-testid="tasks-root">
          recovered
        </div>
      );
    }
    // The lazy chunk fails to load the first time; Retry must re-import it.
    let calls = 0;
    const loader = vi.fn(async () => {
      if (calls++ === 0) throw new Error('chunk load failed');
      return { default: makeApp(Root) };
    });
    await mount(routeEl(loader, 'tasks-retry'));
    await flush();
    // Error boundary fallback is showing its Try again control.
    const retry = [...host!.querySelectorAll('button')].find((b) =>
      /try again/i.test(b.textContent ?? ''),
    );
    expect(retry).toBeTruthy();
    expect(host!.querySelector('[data-testid="tasks-root"]')).toBeNull();

    await act(async () => {
      retry!.click();
    });
    await flush();
    expect(host!.querySelector('[data-testid="tasks-root"]')?.textContent).toBe('recovered');
    // The retry re-imported the descriptor (fresh chunk load path).
    expect(loader.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
