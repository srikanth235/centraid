import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  closeVaultSwitcher,
  isVaultSwitcherOpen,
  openVaultSwitcher,
  updateVaultSwitcherRows,
} from './vaultSwitcher.js';
import type { FlatSwitcherRow, PairRow } from './flatVaultSwitcher-core.js';

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  closeVaultSwitcher();
  document.body.innerHTML = '';
});

const anchor = { left: 12, right: 200, top: 40, bottom: 84, width: 188, height: 44 } as DOMRect;

const pair = (over: Partial<PairRow> & Pick<PairRow, 'vaultId' | 'name'>): PairRow => ({
  kind: 'pair',
  gatewayId: 'local',
  gatewayLabel: 'This Mac',
  gatewayKind: 'local',
  isActive: false,
  gatewayRefreshing: false,
  ...over,
});

const rows: FlatSwitcherRow[] = [
  pair({ vaultId: 'a', name: "Owner's vault", isActive: true }),
  pair({
    vaultId: 'b',
    name: 'Work',
    blurb: 'Side project',
    gatewayId: 'home',
    gatewayLabel: 'home-server',
    gatewayKind: 'remote',
  }),
];

describe('vaultSwitcher', () => {
  it('lists every row, checking the active pair', () => {
    openVaultSwitcher({ anchor, rows, onSelect: () => {}, onManage: () => {} });
    expect(isVaultSwitcherOpen()).toBe(true);
    const listRows = document.querySelectorAll('.row');
    expect(listRows).toHaveLength(2);
    expect(document.querySelector('[data-active="true"]')?.textContent).toContain("Owner's vault");
  });

  it('shows the gateway label as secondary text for each pair', () => {
    openVaultSwitcher({ anchor, rows, onSelect: () => {}, onManage: () => {} });
    const workRow = [...document.querySelectorAll('.row')].find((r) =>
      r.textContent?.includes('Work'),
    )!;
    expect(workRow.textContent).toContain('home-server');
  });

  it('selects on a non-active pair click and closes', () => {
    const onSelect = vi.fn();
    openVaultSwitcher({ anchor, rows, onSelect, onManage: () => {} });
    const workRow = [...document.querySelectorAll<HTMLButtonElement>('.row')].find((r) =>
      r.textContent?.includes('Work'),
    )!;
    workRow.click();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ vaultId: 'b', gatewayId: 'home' }));
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('does not fire onSelect when the already-active row is clicked', () => {
    const onSelect = vi.fn();
    openVaultSwitcher({ anchor, rows, onSelect, onManage: () => {} });
    (document.querySelector('[data-active="true"]') as HTMLButtonElement).click();
    expect(onSelect).not.toHaveBeenCalled();
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('routes the manage row through onManage and closes', () => {
    const onManage = vi.fn();
    openVaultSwitcher({ anchor, rows, onSelect: () => {}, onManage });
    (document.querySelector('.action') as HTMLButtonElement).click();
    expect(onManage).toHaveBeenCalled();
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('closes on backdrop click and fires onClose', () => {
    const onClose = vi.fn();
    openVaultSwitcher({ anchor, rows, onSelect: () => {}, onManage: () => {}, onClose });
    (document.querySelector('.scrim') as HTMLElement).click();
    expect(isVaultSwitcherOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    openVaultSwitcher({ anchor, rows, onSelect: () => {}, onManage: () => {} });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('replaces an open popover rather than stacking', () => {
    openVaultSwitcher({ anchor, rows, onSelect: () => {}, onManage: () => {} });
    openVaultSwitcher({ anchor, rows, onSelect: () => {}, onManage: () => {} });
    expect(document.querySelectorAll('.pop')).toHaveLength(1);
  });

  it('renders a folded, disabled row for an unreachable gateway', () => {
    const withOffline: FlatSwitcherRow[] = [
      ...rows,
      { kind: 'gateway-status', gatewayId: 'office', gatewayLabel: 'office', gatewayKind: 'remote', status: 'unreachable' },
    ];
    openVaultSwitcher({ anchor, rows: withOffline, onSelect: () => {}, onManage: () => {} });
    const offlineRow = [...document.querySelectorAll('.row')].find((r) =>
      r.textContent?.includes('office'),
    )!;
    expect(offlineRow.tagName).toBe('DIV');
    expect(offlineRow.getAttribute('aria-disabled')).toBe('true');
    expect(offlineRow.textContent).toContain('Offline');
  });

  it('does not select on a click through a disabled gateway-status row', () => {
    const onSelect = vi.fn();
    const withOffline: FlatSwitcherRow[] = [
      { kind: 'gateway-status', gatewayId: 'office', gatewayLabel: 'office', gatewayKind: 'remote', status: 'auth_failed' },
    ];
    openVaultSwitcher({ anchor, rows: withOffline, onSelect, onManage: () => {} });
    (document.querySelector('.row') as HTMLElement).click();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('counts only pair rows in the eyebrow, excluding folded offline gateways', () => {
    const withOffline: FlatSwitcherRow[] = [
      ...rows,
      { kind: 'gateway-status', gatewayId: 'office', gatewayLabel: 'office', gatewayKind: 'remote', status: 'unreachable' },
    ];
    openVaultSwitcher({ anchor, rows: withOffline, onSelect: () => {}, onManage: () => {} });
    expect(document.querySelector('[class*="eyebrow"]')?.textContent).toBe('Spaces · 2');
  });

  it('updateVaultSwitcherRows patches the open popover in place', () => {
    openVaultSwitcher({ anchor, rows: [rows[0]!], onSelect: () => {}, onManage: () => {} });
    expect(document.querySelectorAll('.row')).toHaveLength(1);
    updateVaultSwitcherRows(rows);
    expect(document.querySelectorAll('.row')).toHaveLength(2);
  });

  it('updateVaultSwitcherRows is a no-op when the popover is closed', () => {
    expect(() => updateVaultSwitcherRows(rows)).not.toThrow();
    expect(isVaultSwitcherOpen()).toBe(false);
  });
});
