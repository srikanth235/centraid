import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellActions } from '../actions.js';

// Product change (issue #434): APP templates INSTALL in place (registration +
// consent grants, no code copy) — "Use this template" is gone; the card verb is
// Install (Open when already installed). Automation templates keep their
// clone-into-builder flow untouched.
const listTemplates = vi.fn();
const gwCloneTemplate = vi.fn();
const gwInstallTemplate = vi.fn();
vi.mock('../../../gateway-client.js', () => ({
  listTemplates: () => listTemplates(),
  cloneTemplate: (a: unknown) => gwCloneTemplate(a),
  installTemplate: (a: unknown) => gwInstallTemplate(a),
}));

let DiscoverRoute: typeof import('./DiscoverRoute.js').default;
let ShellActionsProvider: typeof import('../actions.js').ShellActionsProvider;
let root: Root | null = null;
let host: HTMLElement | null = null;

const showToast = vi.fn();
const navigate = vi.fn();
const setUserApps = vi.fn();

function makeActions(): ShellActions {
  return {
    showToast,
    builderEnabled: false,
    enterBuilder: vi.fn(),
    openNewAppSheet: vi.fn(),
    openCommandPalette: vi.fn(),
    openContextMenu: vi.fn(),
    confirm: vi.fn().mockResolvedValue(true),
    navigate,
  };
}

const appTemplate = {
  id: 'todos',
  name: 'Todos',
  desc: 'Capture and clear small things.',
  colorKey: 'violet',
  iconKey: 'Todo',
  version: '1.0',
  kind: 'app',
  vault: {
    purpose: 'dpv:ServiceProvision',
    why: 'Keeps your task list.',
    scopes: [{ schema: 'tasks', table: 'add_task', verbs: 'act' }],
  },
};

const autoTemplate = {
  id: 'digest',
  name: 'Digest',
  desc: 'Send a daily roundup.',
  colorKey: 'teal',
  iconKey: 'Bolt',
  version: '1.0',
  kind: 'automation',
  triggerKind: 'cron',
  triggerLabel: 'Daily',
};

beforeEach(async () => {
  ({ default: DiscoverRoute } = await import('./DiscoverRoute.js'));
  ({ ShellActionsProvider } = await import('../actions.js'));
  listTemplates.mockReset().mockResolvedValue([appTemplate, autoTemplate]);
  gwCloneTemplate.mockReset();
  gwInstallTemplate.mockReset();
  showToast.mockClear();
  navigate.mockClear();
  setUserApps.mockClear();
});

const refreshApps = vi.fn().mockResolvedValue(undefined);

async function render(userApps: UserAppMeta[] = []): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <ShellActionsProvider value={makeActions()}>
        <DiscoverRoute userApps={userApps} setUserApps={setUserApps} refreshApps={refreshApps} />
      </ShellActionsProvider>,
    );
  });
  return host;
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  root = null;
  host = null;
  refreshApps.mockClear();
});

describe('DiscoverRoute', () => {
  it('tapping an app card opens the install/consent sheet showing the requested access', async () => {
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.click();
    });
    // The consent sheet renders the why line + a humanized scope sentence.
    expect(document.body.textContent).toContain('What Todos can access');
    expect(document.body.textContent).toContain('Keeps your task list.');
    expect(document.body.textContent).toContain('add task');
  });

  it('clicking "Install" installs in place: pins to Home, refreshes, toasts, and opens the app — no builder, no clone', async () => {
    gwInstallTemplate.mockResolvedValue({
      app: { id: 'todos', name: 'Todos', iconKey: 'Todo', colorKey: 'violet' },
      alreadyInstalled: false,
    });
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.click();
    });
    const installBtn = [...document.querySelectorAll('.primary')].find((b) =>
      b.textContent?.includes('Install'),
    ) as HTMLButtonElement;
    expect(installBtn).toBeTruthy();
    await act(async () => {
      installBtn.click();
      await flush();
    });

    expect(gwInstallTemplate).toHaveBeenCalledWith({ templateId: 'todos' });
    expect(gwCloneTemplate).not.toHaveBeenCalled();
    expect(setUserApps).toHaveBeenCalledTimes(1);
    const [pinned] = setUserApps.mock.calls[0] as [UserAppMeta[]];
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ id: 'todos', name: 'Todos', centraidAppId: 'todos' });
    expect((pinned[0] as unknown as { __draft?: boolean }).__draft).toBeUndefined();
    expect(refreshApps).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Installed "Todos"');
    expect(navigate).toHaveBeenCalledWith({ kind: 'app', id: 'todos' });
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'builder' }));
  });

  it('surfaces a toast and does not navigate when the install fails', async () => {
    gwInstallTemplate.mockRejectedValue(new Error('offline'));
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.click();
    });
    const installBtn = [...document.querySelectorAll('.primary')].find((b) =>
      b.textContent?.includes('Install'),
    ) as HTMLButtonElement;
    await act(async () => {
      installBtn.click();
      await flush();
    });

    expect(showToast).toHaveBeenCalledWith('Install failed: offline');
    expect(setUserApps).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('an already-installed app card OPENS the app instead of showing the install sheet', async () => {
    listTemplates.mockResolvedValue([{ ...appTemplate, installed: true }, autoTemplate]);
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    // The card carries an "Installed" marker.
    expect(card.textContent).toContain('Installed');
    await act(async () => {
      card.click();
    });
    expect(navigate).toHaveBeenCalledWith({ kind: 'app', id: 'todos' });
    // No install sheet, no install call.
    expect(document.querySelector('.tmplPreview')).toBeNull();
    expect(gwInstallTemplate).not.toHaveBeenCalled();
  });

  it('right-clicking an installed app card offers Open, and an uninstalled one offers Install', async () => {
    listTemplates.mockResolvedValue([{ ...appTemplate, installed: true }, autoTemplate]);
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
      );
    });
    const labels = [...document.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent);
    expect(labels).toContain('Open');
    expect(labels).not.toContain('Install');
    expect(labels).not.toContain('Use this template');
  });

  it('an automation template still clones into the automation builder, unaffected by the app-install change', async () => {
    gwCloneTemplate.mockResolvedValue({
      app: { id: 'digest-2', name: 'Digest 2' },
      webhooks: [],
    });
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Digest'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.click();
    });
    const useBtn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Use template'),
    ) as HTMLButtonElement;
    expect(useBtn).toBeTruthy();
    await act(async () => {
      useBtn.click();
      await flush();
    });

    expect(gwCloneTemplate).toHaveBeenCalledWith({ templateId: 'digest' });
    expect(gwInstallTemplate).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ kind: 'automations' });
    expect(setUserApps).not.toHaveBeenCalled();
  });

  it('right-clicking an automation template card and choosing "Use this template" clones it into the automation builder — not the app-install path', async () => {
    gwCloneTemplate.mockResolvedValue({
      app: { id: 'digest-2', name: 'Digest 2' },
      webhooks: [],
    });
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Digest'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
      );
    });
    const useItem = [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
      b.textContent?.includes('Use this template'),
    ) as HTMLButtonElement;
    expect(useItem).toBeTruthy();
    await act(async () => {
      useItem.click();
      await flush();
    });

    expect(gwCloneTemplate).toHaveBeenCalledWith({ templateId: 'digest' });
    expect(navigate).toHaveBeenCalledWith({ kind: 'automations' });
    expect(setUserApps).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith({ kind: 'home' });
  });

  it('right-clicking an automation template card and choosing "Preview" opens the automation preview, not the app-template modal', async () => {
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Digest'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
      );
    });
    const previewItem = [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
      b.textContent?.includes('Preview'),
    ) as HTMLButtonElement;
    await act(async () => {
      previewItem.click();
    });

    expect(document.body.textContent).toContain('Daily');
  });
});
