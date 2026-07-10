import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeVaultSwitcher, isVaultSwitcherOpen, openVaultSwitcher } from './vaultSwitcher.js';

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  closeVaultSwitcher();
  document.body.innerHTML = '';
});

const anchor = { left: 12, right: 200, top: 40, bottom: 84, width: 188, height: 44 } as DOMRect;

const vaults = [
  { vaultId: 'a', name: "Owner's vault", ownerPartyId: 'p1', color: '#4E68DD' },
  { vaultId: 'b', name: 'Work', ownerPartyId: 'p1', color: '#2EA098', blurb: 'Side project' },
];

describe('vaultSwitcher', () => {
  it('lists every vault, checking the active one', () => {
    openVaultSwitcher({
      anchor,
      vaults,
      activeVaultId: 'a',
      onSwitch: () => {},
      onManage: () => {},
    });
    expect(isVaultSwitcherOpen()).toBe(true);
    const rows = document.querySelectorAll('.row');
    expect(rows).toHaveLength(2);
    expect(document.querySelector('[data-active="true"]')?.textContent).toContain("Owner's vault");
  });

  it('switches on a non-active row click and closes', () => {
    const onSwitch = vi.fn();
    openVaultSwitcher({ anchor, vaults, activeVaultId: 'a', onSwitch, onManage: () => {} });
    const rows = [...document.querySelectorAll<HTMLButtonElement>('.row')];
    const workRow = rows.find((r) => r.textContent?.includes('Work'))!;
    workRow.click();
    expect(onSwitch).toHaveBeenCalledWith('b');
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('does not fire onSwitch when the already-active row is clicked', () => {
    const onSwitch = vi.fn();
    openVaultSwitcher({ anchor, vaults, activeVaultId: 'a', onSwitch, onManage: () => {} });
    (document.querySelector('[data-active="true"]') as HTMLButtonElement).click();
    expect(onSwitch).not.toHaveBeenCalled();
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('routes the manage row through onManage and closes', () => {
    const onManage = vi.fn();
    openVaultSwitcher({ anchor, vaults, activeVaultId: 'a', onSwitch: () => {}, onManage });
    (document.querySelector('.action') as HTMLButtonElement).click();
    expect(onManage).toHaveBeenCalled();
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('closes on backdrop click and fires onClose', () => {
    const onClose = vi.fn();
    openVaultSwitcher({ anchor, vaults, activeVaultId: 'a', onSwitch: () => {}, onManage: () => {}, onClose });
    (document.querySelector('.scrim') as HTMLElement).click();
    expect(isVaultSwitcherOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', () => {
    openVaultSwitcher({ anchor, vaults, activeVaultId: 'a', onSwitch: () => {}, onManage: () => {} });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isVaultSwitcherOpen()).toBe(false);
  });

  it('replaces an open popover rather than stacking', () => {
    openVaultSwitcher({ anchor, vaults, activeVaultId: 'a', onSwitch: () => {}, onManage: () => {} });
    openVaultSwitcher({ anchor, vaults, activeVaultId: 'b', onSwitch: () => {}, onManage: () => {} });
    expect(document.querySelectorAll('.pop')).toHaveLength(1);
  });
});
