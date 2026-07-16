import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSettingsBridgeProps, AppSettingsSnapshot } from '../screen-contracts.js';
import AppSettingsPanel from './AppSettingsPanel.js';

function makeSnapshot(over: Partial<AppSettingsSnapshot> = {}): AppSettingsSnapshot {
  return {
    appName: 'Locker',
    iconSvg: '<svg></svg>',
    iconBg: 'linear-gradient(#111,#222)',
    iconColor: '#fff',
    iconShadow: null,
    accent: '#6b5bff',
    vaultVisible: false,
    automationsBadge: null,
    vaultBadge: null,
    knobs: null,
    orders: [],
    ...over,
  };
}

function makeProps(over: Partial<AppSettingsBridgeProps> = {}): AppSettingsBridgeProps {
  return {
    onReady: vi.fn(),
    onClose: vi.fn(),
    onKnobCommit: vi.fn(),
    onRunOrder: vi.fn(),
    onToggleOrder: vi.fn(),
    onOpenOrder: vi.fn(),
    onOpenAutomations: vi.fn(),
    onRename: vi.fn(),
    onShare: vi.fn(),
    onReveal: vi.fn(),
    onDelete: vi.fn(),
    onMountRuns: vi.fn(),
    onMountVault: vi.fn(),
    ...over,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let update: ((s: AppSettingsSnapshot) => void) | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  update = null;
  vi.clearAllMocks();
});
function mount(props: AppSettingsBridgeProps): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const onReady = (u: (s: AppSettingsSnapshot) => void): void => {
    update = u;
  };
  act(() => {
    root = createRoot(container as HTMLDivElement);
    root.render(<AppSettingsPanel {...props} onReady={onReady} />);
  });
  return container;
}
function push(snap: AppSettingsSnapshot): void {
  act(() => update?.(snap));
}
function clickTab(el: HTMLElement, label: string): void {
  const btn = [...el.querySelectorAll<HTMLButtonElement>('.settingsTabs button')].find((b) =>
    b.textContent?.includes(label),
  )!;
  void act(() => btn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
}

describe('AppSettingsPanel', () => {
  it('renders header identity and closes on the X and backdrop', () => {
    const props = makeProps();
    const el = mount(props);
    push(makeSnapshot());
    expect(el.querySelector('.settingsName')?.textContent).toBe('Locker');
    void act(() =>
      (el.querySelector('.settingsClose') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    void act(() =>
      (el.querySelector('.settingsBackdrop') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onClose).toHaveBeenCalledTimes(2);
  });

  it('hides the Vault tab until the manifest declares one', () => {
    const el = mount(makeProps());
    push(makeSnapshot({ vaultVisible: false }));
    expect(
      [...el.querySelectorAll('.settingsTabs button')].some((b) =>
        b.textContent?.includes('Vault'),
      ),
    ).toBe(false);
    push(makeSnapshot({ vaultVisible: true, vaultBadge: 3 }));
    const vaultTab = [...el.querySelectorAll('.settingsTabs button')].find((b) =>
      b.textContent?.includes('Vault'),
    )!;
    expect(vaultTab).toBeTruthy();
    expect(vaultTab.querySelector('.settingsTabBadge')?.textContent).toBe('3');
  });

  it('renders appearance knobs and commits a change', () => {
    const props = makeProps();
    const el = mount(props);
    push(
      makeSnapshot({
        knobs: [
          {
            key: 'appFont',
            label: 'Font',
            type: 'segmented',
            value: 'sans',
            options: [
              { value: 'sans', label: 'Sans' },
              { value: 'serif', label: 'Serif' },
            ],
          },
        ],
      }),
    );
    const serif = [...el.querySelectorAll<HTMLButtonElement>('.seg button')].find(
      (b) => b.textContent === 'Serif',
    )!;
    expect(serif.dataset.active).toBe('false');
    void act(() => serif.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onKnobCommit).toHaveBeenCalledWith('appFont', 'serif');
    expect(serif.dataset.active).toBe('true');
  });

  it('shows the empty appearance note when there are no knobs', () => {
    const el = mount(makeProps());
    push(makeSnapshot({ knobs: null }));
    expect(el.textContent).toContain('No appearance options');
  });

  it('renders standing orders and fires run / toggle / open', () => {
    const props = makeProps();
    const el = mount(props);
    push(
      makeSnapshot({
        automationsBadge: 1,
        orders: [
          {
            id: 'a1',
            ref: 'auto/a1',
            name: 'Daily digest',
            schedule: 'Every day at 8am',
            prompt: 'Summarize the inbox.',
            appsLabel: 'Apps: locker',
            enabled: true,
            run: { kind: 'idle' },
          },
        ],
      }),
    );
    clickTab(el, 'Automations');
    expect(el.querySelector('.orderName')?.textContent).toBe('Daily digest');
    expect(el.querySelector('.orderSchedule')?.textContent).toBe('Every day at 8am');
    void act(() =>
      (el.querySelector('.orderRun') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onRunOrder).toHaveBeenCalledWith('auto/a1');
    act(() => (el.querySelector('.orderToggle input') as HTMLInputElement).click());
    expect(props.onToggleOrder).toHaveBeenCalledWith('auto/a1', false);
    void act(() =>
      (el.querySelector('.orderName') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onOpenOrder).toHaveBeenCalledWith('auto/a1');
  });

  it('reflects a running order and a done result chip', () => {
    const el = mount(makeProps());
    push(
      makeSnapshot({
        orders: [
          {
            id: 'a1',
            ref: 'auto/a1',
            name: 'Digest',
            schedule: 'daily',
            prompt: 'go',
            appsLabel: 'No apps linked',
            enabled: true,
            run: { kind: 'running' },
          },
        ],
      }),
    );
    clickTab(el, 'Automations');
    const runBtn = el.querySelector('.orderRun') as HTMLButtonElement;
    expect(runBtn.disabled).toBe(true);
    expect(runBtn.textContent).toBe('Running…');
    push(
      makeSnapshot({
        orders: [
          {
            id: 'a1',
            ref: 'auto/a1',
            name: 'Digest',
            schedule: 'daily',
            prompt: 'go',
            appsLabel: 'No apps linked',
            enabled: true,
            run: { kind: 'done', ok: true, label: 'Ran in 1.2s' },
          },
        ],
      }),
    );
    expect(el.querySelector('.orderResult')?.textContent).toBe('Ran in 1.2s');
  });

  it('lazily mounts the vanilla runs host on first expand', () => {
    const props = makeProps();
    const el = mount(props);
    push(
      makeSnapshot({
        orders: [
          {
            id: 'a1',
            ref: 'auto/a1',
            name: 'Digest',
            schedule: 'daily',
            prompt: 'go',
            appsLabel: 'x',
            enabled: true,
            run: { kind: 'idle' },
          },
        ],
      }),
    );
    clickTab(el, 'Automations');
    expect(props.onMountRuns).not.toHaveBeenCalled();
    void act(() =>
      (el.querySelector('.orderRunsToggle') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onMountRuns).toHaveBeenCalledTimes(1);
    expect(props.onMountRuns).toHaveBeenCalledWith('auto/a1', expect.any(HTMLElement));
  });

  it('injects the vault pane host when the Vault tab shows', () => {
    const props = makeProps();
    mount(props);
    push(makeSnapshot({ vaultVisible: true }));
    expect(props.onMountVault).toHaveBeenCalledTimes(1);
    expect(props.onMountVault).toHaveBeenCalledWith(expect.any(HTMLElement));
  });

  it('arms then confirms delete; fires rename/share/reveal', () => {
    const props = makeProps();
    const el = mount(props);
    push(makeSnapshot());
    clickTab(el, 'Manage');
    const del = el.querySelector('.settingsDangerItem') as HTMLButtonElement;
    void act(() => del.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(del.dataset.armed).toBe('true');
    void act(() => del.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onDelete).toHaveBeenCalledTimes(1);

    const items = [...el.querySelectorAll<HTMLButtonElement>('.settingsManage .settingsMenuItem')];
    void act(() => items[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onRename).toHaveBeenCalled();
    void act(() => items[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onShare).toHaveBeenCalled();
    void act(() => items[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(props.onReveal).toHaveBeenCalled();
  });

  it('opens the Automations destination from the pane link', () => {
    const props = makeProps();
    const el = mount(props);
    push(makeSnapshot());
    clickTab(el, 'Automations');
    void act(() =>
      (el.querySelector('.settingsPaneLink') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      ),
    );
    expect(props.onOpenAutomations).toHaveBeenCalled();
  });
});
