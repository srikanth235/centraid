import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellActions } from '../actions.js';

// Product change: "Use template" for an APP template installs it directly as
// a published app (owner decision) — no draft stage, no builder detour.
// Automation templates keep their existing clone-into-builder flow untouched.
const listTemplates = vi.fn();
const gwCloneTemplate = vi.fn();
vi.mock('../../../gateway-client.js', () => ({
  listTemplates: () => listTemplates(),
  cloneTemplate: (a: unknown) => gwCloneTemplate(a),
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
  it('opening an app template preview and clicking "Use this template" installs it: pins to Home, refreshes, toasts, and navigates home — no builder', async () => {
    gwCloneTemplate.mockResolvedValue({
      app: { id: 'todos-2', name: 'Todos 2', description: 'cloned' },
      template: { name: 'Todos' },
    });
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.click();
    });
    const useBtn = [...document.querySelectorAll('.primary')].find((b) =>
      b.textContent?.includes('Use this template'),
    ) as HTMLButtonElement;
    expect(useBtn).toBeTruthy();
    await act(async () => {
      useBtn.click();
      await flush();
    });

    expect(gwCloneTemplate).toHaveBeenCalledWith({ templateId: 'todos' });
    expect(setUserApps).toHaveBeenCalledTimes(1);
    const [pinned] = setUserApps.mock.calls[0] as [UserAppMeta[]];
    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ id: 'todos-2', name: 'Todos 2', centraidAppId: 'todos-2' });
    expect((pinned[0] as unknown as { __draft?: boolean }).__draft).toBeUndefined();
    expect(refreshApps).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith('Installed "Todos 2"');
    expect(navigate).toHaveBeenCalledWith({ kind: 'home' });
    // Never routes through the builder for an app template.
    expect(navigate).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'builder' }));
  });

  it('surfaces a toast and does not navigate when the clone fails', async () => {
    gwCloneTemplate.mockRejectedValue(new Error('offline'));
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Todos'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.click();
    });
    const useBtn = [...document.querySelectorAll('.primary')].find((b) =>
      b.textContent?.includes('Use this template'),
    ) as HTMLButtonElement;
    await act(async () => {
      useBtn.click();
      await flush();
    });

    expect(showToast).toHaveBeenCalledWith('Clone failed: offline');
    expect(setUserApps).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
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
    expect(navigate).toHaveBeenCalledWith({ kind: 'automation-builder', automationId: 'digest-2' });
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
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
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
    expect(navigate).toHaveBeenCalledWith({ kind: 'automation-builder', automationId: 'digest-2' });
    // Never mis-pinned to Home as if it were an app template.
    expect(setUserApps).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalledWith({ kind: 'home' });
  });

  it('right-clicking an automation template card and choosing "Preview" opens the automation preview, not the app-template modal', async () => {
    const el = await render([]);
    const card = [...el.querySelectorAll('.card')].find((c) =>
      c.textContent?.includes('Digest'),
    ) as HTMLButtonElement;
    await act(async () => {
      card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    const previewItem = [...document.querySelectorAll('[role="menuitem"]')].find((b) =>
      b.textContent?.includes('Preview'),
    ) as HTMLButtonElement;
    await act(async () => {
      previewItem.click();
    });

    // The automation preview drawer renders its trigger info ("Daily");
    // the plain app-template preview modal has no such field.
    expect(document.body.textContent).toContain('Daily');
  });
});
