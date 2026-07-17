import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellActions } from '../actions.js';

// Issue #434, Phase 2 — the installed-app context menu rework. A bundled
// install (its id is a reserved bundled-template id) gets Open / App info /
// Rename / Star / Uninstall (Share + Reveal dropped, Delete → Uninstall with
// the data-stays copy). A code-store app keeps Delete.

const listAutomations = vi.fn();
const deleteApp = vi.fn();
const deleteAutomation = vi.fn();
const runAutomationNow = vi.fn();
const updateAppMeta = vi.fn();
const renameInstalledApp = vi.fn();
vi.mock('../../../gateway-client.js', () => ({
  listAutomations: () => listAutomations(),
  deleteApp: (a: unknown) => deleteApp(a),
  deleteAutomation: (a: unknown) => deleteAutomation(a),
  runAutomationNow: (a: unknown) => runAutomationNow(a),
  updateAppMeta: (a: unknown) => updateAppMeta(a),
  renameInstalledApp: (a: unknown) => renameInstalledApp(a),
}));
vi.mock('./automationsData.js', () => ({ collectAutomationRuns: () => Promise.resolve([]) }));
const loadAppTemplates = vi.fn();
vi.mock('./templatesData.js', () => ({ loadAppTemplates: () => loadAppTemplates() }));

// App info reuses the per-app consent pane — stub its data layer so the modal
// renders the requested access + a live grant without real gateway I/O.
vi.mock('./appSettingsData.js', () => ({
  fetchAppManifestRaw: () => Promise.resolve({ vault: {} }),
  manifestVaultBlock: () => ({
    purpose: 'dpv:ServiceProvision',
    why: 'Shows your photo library.',
    scopes: [{ schema: 'media', verbs: 'read' }],
  }),
  buildVaultProps: () => ({
    block: {
      purpose: 'dpv:ServiceProvision',
      why: 'Shows your photo library.',
      scopes: [{ schema: 'media', verbs: 'read' }],
    },
    loadData: () =>
      Promise.resolve({
        vaultName: 'My Vault',
        grants: [
          {
            grantId: 'g1',
            purpose: 'Service',
            scopes: [{ schema: 'media', table: null, verbs: 'read' }],
            expiresAt: null,
          },
        ],
        parked: [],
      }),
    grant: () => Promise.resolve(),
    revoke: () => Promise.resolve(),
    confirm: () => Promise.resolve(),
    demoLoad: () => Promise.resolve(),
    demoPurge: () => Promise.resolve(),
  }),
}));

let HomeRoute: typeof import('./HomeRoute.js').default;
let ShellActionsProvider: typeof import('../actions.js').ShellActionsProvider;
let root: Root | null = null;
let host: HTMLElement | null = null;

const showToast = vi.fn();
const navigate = vi.fn();
const confirm = vi.fn();

function makeActions(): ShellActions {
  return {
    showToast,
    builderEnabled: false,
    enterBuilder: vi.fn(),
    openNewAppSheet: vi.fn(),
    openCommandPalette: vi.fn(),
    openContextMenu: vi.fn(),
    confirm,
    navigate,
  };
}

const app = (id: string, name = id): UserAppMeta =>
  ({
    id,
    name,
    iconKey: 'Todo',
    color: '#123',
    updatedAt: '2020-01-01T00:00:00Z',
  }) as unknown as UserAppMeta;

const refreshApps = vi.fn().mockResolvedValue(undefined);

async function render(userApps: UserAppMeta[]): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ShellActionsProvider value={makeActions()}>
        <HomeRoute
          userApps={userApps}
          drafts={[]}
          tileVariant="gradient"
          isStarred={() => false}
          toggleStar={vi.fn()}
          refreshApps={refreshApps}
        />
      </ShellActionsProvider>,
    );
    await flush();
  });
  return host;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function openMenuFor(id: string): void {
  const tile = document.querySelector(
    `[data-app-id="${id}"] [data-testid="app-tile"]`,
  ) as HTMLElement;
  tile.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 5, clientY: 5 }));
}

function menuLabels(): (string | null)[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
}

function clickMenuItem(label: string): void {
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (b) => b.textContent === label,
  ) as HTMLButtonElement;
  item.click();
}

beforeEach(async () => {
  (globalThis as unknown as { CentraidTokens: unknown }).CentraidTokens = {
    tileFinish: () => ({ background: '#111', boxShadow: 'none', glyphColor: '#fff' }),
  };
  ({ default: HomeRoute } = await import('./HomeRoute.js'));
  ({ ShellActionsProvider } = await import('../actions.js'));
  listAutomations.mockReset().mockResolvedValue([]);
  loadAppTemplates.mockReset().mockResolvedValue([{ id: 'photos', kind: 'app' }]);
  deleteApp.mockReset().mockResolvedValue({ ok: true });
  updateAppMeta.mockReset().mockResolvedValue({ ok: true });
  renameInstalledApp.mockReset().mockResolvedValue({ ok: true });
  showToast.mockClear();
  navigate.mockClear();
  confirm.mockReset().mockResolvedValue(true);
  refreshApps.mockClear();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  root = null;
  host = null;
});

describe('HomeRoute installed-app context menu', () => {
  it('a bundled install shows Open / App info / Rename / Star / Uninstall — no Delete, Share, or Reveal', async () => {
    await render([app('photos', 'Photos')]);
    openMenuFor('photos');
    const labels = menuLabels();
    expect(labels).toEqual(['Open', 'App info', 'Rename', 'Star', 'Uninstall']);
    expect(labels).not.toContain('Delete');
    expect(labels).not.toContain('Share');
    expect(labels).not.toContain('Reveal in Finder');
  });

  it('a code-store app keeps Delete (not Uninstall)', async () => {
    await render([app('notes-x1', 'My Notes')]);
    openMenuFor('notes-x1');
    const labels = menuLabels();
    expect(labels).toContain('Delete');
    expect(labels).not.toContain('Uninstall');
    expect(labels).not.toContain('App info');
  });

  it('Uninstall confirms with the data-stays copy, then calls deleteApp', async () => {
    await render([app('photos', 'Photos')]);
    openMenuFor('photos');
    await act(async () => {
      clickMenuItem('Uninstall');
      await flush();
    });
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        confirmLabel: 'Uninstall',
        title: 'Uninstall Photos?',
        message: 'Removes "Photos" and revokes its access. Your data stays in your vault.',
      }),
    );
    expect(deleteApp).toHaveBeenCalledWith({ id: 'photos' });
    expect(showToast).toHaveBeenCalledWith('Uninstalled "Photos"');
  });

  it('Rename on a bundled app uses the session-free path (renameInstalledApp, not updateAppMeta)', async () => {
    // openPrompt is a body-portal overlay; stub it to return a new name.
    const prompt = await import('../prompt.js');
    vi.spyOn(prompt, 'openPrompt').mockResolvedValue('Family Photos');
    await render([app('photos', 'Photos')]);
    openMenuFor('photos');
    await act(async () => {
      clickMenuItem('Rename');
      await flush();
    });
    expect(renameInstalledApp).toHaveBeenCalledWith({ id: 'photos', name: 'Family Photos' });
    expect(updateAppMeta).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('App info opens the consent surface — requested access + live grants — with an Uninstall action', async () => {
    await render([app('photos', 'Photos')]);
    openMenuFor('photos');
    await act(async () => {
      clickMenuItem('App info');
      await flush();
    });
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('App info');
    expect(dialog.textContent).toContain('Requested access');
    expect(dialog.textContent).toContain('Shows your photo library.');
    // The live grant from loadData renders.
    expect(dialog.textContent).toContain('Access · My Vault');
    expect(dialog.textContent).toContain('media');
    expect(dialog.textContent).toContain('Uninstall');
  });

  it('App info offers an "Automate on this data" deep-link into the editor pre-watching the kind', async () => {
    // The app requests one scope (`media`); the modal offers a per-kind
    // "Automate media" button that deep-links to the automation editor with
    // that entity kind pre-filled as a data trigger (issue #446 follow-up 1).
    await render([app('photos', 'Photos')]);
    openMenuFor('photos');
    await act(async () => {
      clickMenuItem('App info');
      await flush();
    });
    const automate = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent === 'Automate media',
    ) as HTMLButtonElement;
    expect(automate).toBeTruthy();
    await act(async () => {
      automate.click();
      await flush();
    });
    expect(navigate).toHaveBeenCalledWith({ kind: 'automation-editor', watchEntity: 'media' });
    // The modal closes on navigate.
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
