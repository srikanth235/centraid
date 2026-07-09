import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeContextMenu, isContextMenuOpen, openMenu } from './contextMenu.js';

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  closeContextMenu();
  document.body.innerHTML = '';
});

const anchor = { kind: 'point', x: 10, y: 10 } as const;

describe('context menu', () => {
  it('renders the items + separators at the anchor', () => {
    openMenu(
      [
        { id: 'open', label: 'Open', icon: 'Eye' },
        'sep',
        { id: 'delete', label: 'Delete', icon: 'Trash', danger: true },
      ],
      anchor,
      () => {},
    );
    expect(isContextMenuOpen()).toBe(true);
    const menu = document.querySelector('.ctx-menu')!;
    expect(menu.querySelectorAll('.ctx-item')).toHaveLength(2);
    expect(menu.querySelector('.ctx-sep')).not.toBeNull();
    expect(menu.textContent).toContain('Open');
    expect(
      (menu.querySelector('[data-danger="true"]') as HTMLElement).textContent,
    ).toContain('Delete');
  });

  it('fires onPick with the item id and closes', () => {
    const onPick = vi.fn();
    openMenu([{ id: 'star', label: 'Star', icon: 'Star' }], anchor, onPick);
    (document.querySelector('.ctx-item') as HTMLButtonElement).click();
    expect(onPick).toHaveBeenCalledWith('star');
    expect(isContextMenuOpen()).toBe(false);
  });

  it('closes on backdrop click without picking', () => {
    const onPick = vi.fn();
    openMenu([{ id: 'x', label: 'X', icon: 'X' }], anchor, onPick);
    (document.querySelector('.ctx-backdrop') as HTMLElement).click();
    expect(onPick).not.toHaveBeenCalled();
    expect(isContextMenuOpen()).toBe(false);
  });

  it('replaces an open menu rather than stacking', () => {
    openMenu([{ id: 'a', label: 'A', icon: 'Star' }], anchor, () => {});
    openMenu([{ id: 'b', label: 'B', icon: 'Star' }], anchor, () => {});
    expect(document.querySelectorAll('.ctx-menu')).toHaveLength(1);
  });
});
