import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeVaultSwitcher,
  isVaultSwitcherOpen,
  openVaultSwitcher,
  updateVaultSwitcherRows,
} from './vaultSwitcher.js';
import { closeContextMenu } from './contextMenu.js';
import type { GroupedSwitcherGateway, PairRow } from './flatVaultSwitcher-core.js';

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  closeVaultSwitcher();
  closeContextMenu();
  document.body.innerHTML = '';
});

const anchor = { left: 12, right: 200, top: 40, bottom: 84, width: 188, height: 44 } as DOMRect;

const vault = (over: Partial<PairRow> & Pick<PairRow, 'vaultId' | 'name'>): PairRow => ({
  gatewayId: 'local',
  gatewayKind: 'local',
  gatewayLabel: 'This Mac',
  gatewayRefreshing: false,
  isActive: false,
  kind: 'pair',
  ...over,
});

const group = (
  over: Partial<GroupedSwitcherGateway> & Pick<GroupedSwitcherGateway, 'gatewayId'>,
): GroupedSwitcherGateway => ({
  canCreateVault: true,
  gatewayKind: 'local',
  gatewayLabel: 'This Mac',
  gatewayRefreshing: false,
  status: 'ready',
  transportBadge: 'This Mac',
  vaults: [],
  ...over,
});

const groups: GroupedSwitcherGateway[] = [
  group({
    gatewayId: 'local',
    vaults: [vault({ vaultId: 'a', name: "Owner's vault", isActive: true })],
  }),
  group({
    canCreateVault: false,
    gatewayId: 'home',
    gatewayKind: 'remote',
    gatewayLabel: 'home-server',
    transportBadge: 'iroh',
    vaults: [
      vault({
        vaultId: 'b',
        name: 'Work',
        blurb: 'Side project',
        gatewayId: 'home',
        gatewayLabel: 'home-server',
        gatewayKind: 'remote',
      }),
    ],
  }),
];

function baseOpts(over: Partial<Parameters<typeof openVaultSwitcher>[0]> = {}) {
  return {
    anchor,
    groups,
    onAddGateway: vi.fn(),
    onNewSpace: vi.fn(),
    onRemoveGateway: vi.fn(),
    onRenameGateway: vi.fn(),
    onSelectVault: vi.fn(),
    onTestConnection: vi.fn(),
    ...over,
  };
}

describe('vaultSwitcher (grouped)', () => {
  it('renders one header per gateway with nested vault rows, checking the active vault', () => {
    openVaultSwitcher(baseOpts());
    expect(isVaultSwitcherOpen()).toBe(true);
    expect(document.querySelectorAll('.group')).toHaveLength(2);
    expect(document.querySelectorAll('.row')).toHaveLength(2);
    expect(document.querySelector('[data-active="true"]')?.textContent).toContain("Owner's vault");
    expect(document.textContent).toBeDefined();
  });

  it('shows the gateway label + transport badge on each header', () => {
    openVaultSwitcher(baseOpts());
    const headers = [...document.querySelectorAll('.header')];
    const home = headers.find((h) => h.textContent?.includes('home-server'))!;
    expect(home.textContent).toContain('iroh');
  });

  it('selects on a non-active vault click and closes', () => {
    const onSelectVault = vi.fn();
    openVaultSwitcher(baseOpts({ onSelectVault }));
    const workRow = [...document.querySelectorAll<HTMLButtonElement>('.row')].find((r) =>
      r.textContent?.includes('Work'),
    )!;
    workRow.click();
    expect(onSelectVault).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: 'b', gatewayId: 'home' }),
    );
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('does not fire onSelectVault when the already-active row is clicked', () => {
    const onSelectVault = vi.fn();
    openVaultSwitcher(baseOpts({ onSelectVault }));
    (document.querySelector('[data-active="true"]') as HTMLButtonElement).click();
    expect(onSelectVault).not.toHaveBeenCalled();
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('a create-capable gateway shows a "New space" header action that fires onNewSpace', () => {
    const onNewSpace = vi.fn();
    openVaultSwitcher(baseOpts({ onNewSpace }));
    const localHeader = [...document.querySelectorAll('.group')].find((g) =>
      g.textContent?.includes('This Mac'),
    )!;
    (localHeader.querySelector('[title="New space…"]') as HTMLButtonElement).click();
    expect(onNewSpace).toHaveBeenCalledWith('local');
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('a non-create-capable gateway has no "New space" action', () => {
    openVaultSwitcher(baseOpts());
    const homeHeader = [...document.querySelectorAll('.group')].find((g) =>
      g.textContent?.includes('home-server'),
    )!;
    expect(homeHeader.querySelector('[title="New space…"]')).toBeNull();
  });

  it('the overflow menu offers Test/Rename/Remove for a remote gateway', () => {
    openVaultSwitcher(baseOpts());
    const homeHeader = [...document.querySelectorAll('.group')].find((g) =>
      g.textContent?.includes('home-server'),
    )!;
    (homeHeader.querySelector('[title="More"]') as HTMLButtonElement).click();
    const items = [...document.querySelectorAll('.item')].map((i) => i.textContent);
    expect(items).toEqual(['Test connection…', 'Rename…', 'Remove']);
  });

  it('the overflow menu omits Remove for the local gateway', () => {
    openVaultSwitcher(baseOpts());
    const localHeader = [...document.querySelectorAll('.group')].find((g) =>
      g.textContent?.includes('This Mac'),
    )!;
    (localHeader.querySelector('[title="More"]') as HTMLButtonElement).click();
    const items = [...document.querySelectorAll('.item')].map((i) => i.textContent);
    expect(items).toEqual(['Test connection…', 'Rename…']);
  });

  it('picking "Test connection…" fires onTestConnection with that gateway id and closes the switcher', () => {
    const onTestConnection = vi.fn();
    openVaultSwitcher(baseOpts({ onTestConnection }));
    const homeHeader = [...document.querySelectorAll('.group')].find((g) =>
      g.textContent?.includes('home-server'),
    )!;
    (homeHeader.querySelector('[title="More"]') as HTMLButtonElement).click();
    (document.querySelector('.item') as HTMLButtonElement).click();
    expect(onTestConnection).toHaveBeenCalledWith('home');
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('picking "Remove" fires onRemoveGateway with that gateway id', () => {
    const onRemoveGateway = vi.fn();
    openVaultSwitcher(baseOpts({ onRemoveGateway }));
    const homeHeader = [...document.querySelectorAll('.group')].find((g) =>
      g.textContent?.includes('home-server'),
    )!;
    (homeHeader.querySelector('[title="More"]') as HTMLButtonElement).click();
    const removeItem = [...document.querySelectorAll('.item')].find(
      (i) => i.textContent === 'Remove',
    ) as HTMLButtonElement;
    removeItem.click();
    expect(onRemoveGateway).toHaveBeenCalledWith('home');
  });

  it('routes the footer row through onAddGateway and closes', () => {
    const onAddGateway = vi.fn();
    openVaultSwitcher(baseOpts({ onAddGateway }));
    (document.querySelector('.action') as HTMLButtonElement).click();
    expect(onAddGateway).toHaveBeenCalled();
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('closes on backdrop click and fires onClose', () => {
    const onClose = vi.fn();
    openVaultSwitcher(baseOpts({ onClose }));
    (document.querySelector('.scrim') as HTMLElement).click();
    expect(isVaultSwitcherOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    openVaultSwitcher(baseOpts());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('replaces an open popover rather than stacking', () => {
    openVaultSwitcher(baseOpts());
    openVaultSwitcher(baseOpts());
    expect(document.querySelectorAll('.pop')).toHaveLength(1);
  });

  it('renders a status line for a gateway with no known vaults yet', () => {
    const loading: GroupedSwitcherGateway[] = [
      group({
        gatewayId: 'office',
        gatewayKind: 'remote',
        gatewayLabel: 'office',
        status: 'loading',
        transportBadge: 'iroh',
        canCreateVault: false,
      }),
    ];
    openVaultSwitcher(baseOpts({ groups: loading }));
    expect(document.querySelector('.statusRow')?.textContent).toBe('Checking…');
  });

  it('renders "Offline" for an unreachable gateway with no cached vaults', () => {
    const offline: GroupedSwitcherGateway[] = [
      group({
        gatewayId: 'office',
        gatewayKind: 'remote',
        gatewayLabel: 'office',
        status: 'unreachable',
        transportBadge: 'iroh',
        canCreateVault: false,
      }),
    ];
    openVaultSwitcher(baseOpts({ groups: offline }));
    expect(document.querySelector('.statusRow')?.textContent).toBe('Offline');
  });

  it('counts vault rows across all groups in the eyebrow', () => {
    openVaultSwitcher(baseOpts());
    expect(document.querySelector('[class*="eyebrow"]')?.textContent).toBe('Spaces · 2');
  });

  it('updateVaultSwitcherRows patches the open popover in place', () => {
    openVaultSwitcher(baseOpts({ groups: [groups[0]!] }));
    expect(document.querySelectorAll('.row')).toHaveLength(1);
    updateVaultSwitcherRows(groups);
    expect(document.querySelectorAll('.row')).toHaveLength(2);
  });

  it('updateVaultSwitcherRows is a no-op when the popover is closed', () => {
    expect(() => updateVaultSwitcherRows(groups)).not.toThrow();
    expect(isVaultSwitcherOpen()).toBe(false);
  });
});
