import type { ShellMenuAnchor } from './Sidebar.js';
import { iconSvg } from './iconSvg.js';

// Context menu — the generic anchored popup menu, ported from the vanilla
// app-cards.ts openMenu/closeContextMenu. A body-portal overlay (same
// ctx-backdrop / ctx-menu / ctx-item global classes) with the same edge-flip
// positioning, callable from any surface. The item lists + the picked-action
// dispatch (app menu, template menu) are the caller's — this owns only the
// popup mechanics.

export interface CtxItem {
  id: string;
  label: string;
  icon: string;
  danger?: boolean;
}

let ctxBackdrop: HTMLElement | null = null;
let ctxMenu: HTMLElement | null = null;

export function closeContextMenu(): void {
  ctxBackdrop?.remove();
  ctxMenu?.remove();
  ctxBackdrop = null;
  ctxMenu = null;
}

export function isContextMenuOpen(): boolean {
  return ctxMenu !== null;
}

export function openMenu(
  items: ReadonlyArray<CtxItem | 'sep'>,
  anchor: ShellMenuAnchor,
  onPick: (id: string) => void,
): void {
  closeContextMenu();

  ctxBackdrop = document.createElement('div');
  ctxBackdrop.className = 'ctx-backdrop';
  ctxBackdrop.addEventListener('click', closeContextMenu);
  ctxBackdrop.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    closeContextMenu();
  });
  document.body.append(ctxBackdrop);

  ctxMenu = document.createElement('div');
  ctxMenu.className = 'ctx-menu';
  ctxMenu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      ctxMenu.append(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.setAttribute('role', 'menuitem');
    btn.dataset.danger = String(!!it.danger);
    btn.innerHTML = `${iconSvg(it.icon, 15)}<span>${it.label}</span>`;
    btn.addEventListener('click', () => {
      const id = it.id;
      closeContextMenu();
      onPick(id);
    });
    ctxMenu.append(btn);
  }
  document.body.append(ctxMenu);

  const w = ctxMenu.offsetWidth;
  const h = ctxMenu.offsetHeight;
  let px: number;
  let py: number;
  if (anchor.kind === 'point') {
    px = Math.min(anchor.x, window.innerWidth - w - 8);
    py = Math.min(anchor.y, window.innerHeight - h - 8);
  } else {
    const r = anchor.rect;
    py = r.bottom + 4;
    px = r.left;
    if (px + w > window.innerWidth - 8) px = r.right - w;
    if (py + h > window.innerHeight - 8) py = r.top - h - 4;
  }
  ctxMenu.style.left = `${Math.max(8, px)}px`;
  ctxMenu.style.top = `${Math.max(8, py)}px`;
}
