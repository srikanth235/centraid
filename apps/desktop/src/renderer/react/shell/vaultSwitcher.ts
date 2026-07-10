import { tileFinish } from '@centraid/design-tokens';
import type { VaultListEntry } from '../../gateway-client.js';
import { iconSvg } from './iconSvg.js';
import { DEFAULT_SPACE_ICON, PROFILE_COLORS } from './routes/SpaceModal.js';
import styles from './vaultSwitcher.module.css';

// Vault quick-switcher popover — ported from the vanilla profiles.ts
// `openDropdown`. A generic anchored body-portal overlay, same mechanics as
// `contextMenu.ts` (and for the same reason: the sidebar column clips
// `overflow: hidden` and, in themes with a blurred sidebar, a
// `backdrop-filter` establishes a containing block that would trap a plain
// `position: fixed` descendant — appending straight to `document.body`
// sidesteps both).
//
// Deliberately simplified vs. the vanilla dropdown: no per-row hover-reveal
// edit button and no inline add/rename/delete — those already have a home in
// the ported Settings → Spaces page (`SettingsProfilesScreen.tsx` +
// `SpaceModal.tsx`), so the popover's "Manage spaces" row links there instead
// of re-implementing the same modals in miniature.

export interface VaultSwitcherOpts {
  anchor: DOMRect;
  vaults: VaultListEntry[];
  activeVaultId: string;
  onSwitch: (vaultId: string) => void;
  onManage: () => void;
  /** Called once, however the popover closes (row pick, backdrop, Escape,
   *  or a subsequent open call) — lets the trigger button drop its
   *  `data-open` styling. */
  onClose?: () => void;
}

let backdropEl: HTMLElement | null = null;
let popEl: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let closeCb: (() => void) | null = null;

export function isVaultSwitcherOpen(): boolean {
  return popEl !== null;
}

export function closeVaultSwitcher(): void {
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  backdropEl?.remove();
  backdropEl = null;
  popEl?.remove();
  popEl = null;
  const cb = closeCb;
  closeCb = null;
  cb?.();
}

function avatarNode(color: string | undefined, icon: string | undefined): HTMLElement {
  const finish = tileFinish(color ?? PROFILE_COLORS[0]!, 'gradient');
  const span = document.createElement('span');
  span.className = styles.avatar ?? '';
  span.style.background = finish.background;
  if (finish.boxShadow) span.style.boxShadow = finish.boxShadow;
  span.style.color = finish.glyphColor;
  span.innerHTML = iconSvg(icon ?? DEFAULT_SPACE_ICON, 15, 1.9);
  return span;
}

export function openVaultSwitcher(opts: VaultSwitcherOpts): void {
  closeVaultSwitcher();
  closeCb = opts.onClose ?? null;

  backdropEl = document.createElement('div');
  backdropEl.className = styles.scrim ?? '';
  backdropEl.addEventListener('click', () => closeVaultSwitcher());
  document.body.append(backdropEl);

  popEl = document.createElement('div');
  popEl.className = styles.pop ?? '';
  popEl.setAttribute('role', 'menu');

  const eyebrow = document.createElement('div');
  eyebrow.className = styles.eyebrow ?? '';
  eyebrow.textContent = `Spaces · ${opts.vaults.length}`;
  popEl.append(eyebrow);

  const list = document.createElement('div');
  list.className = styles.list ?? '';
  for (const v of opts.vaults) {
    const isActive = v.vaultId === opts.activeVaultId;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = styles.row ?? '';
    row.setAttribute('role', 'menuitem');
    row.dataset.active = String(isActive);
    row.append(avatarNode(v.color, v.icon));

    const text = document.createElement('span');
    text.className = styles.text ?? '';
    const nameEl = document.createElement('span');
    nameEl.className = styles.name ?? '';
    nameEl.textContent = v.name;
    text.append(nameEl);
    if (v.blurb) {
      const sub = document.createElement('span');
      sub.className = styles.sub ?? '';
      sub.textContent = v.blurb;
      text.append(sub);
    }
    row.append(text);

    const check = document.createElement('span');
    check.className = styles.check ?? '';
    if (isActive) check.innerHTML = iconSvg('Check', 14, 2.2);
    row.append(check);

    row.addEventListener('click', () => {
      closeVaultSwitcher();
      if (!isActive) opts.onSwitch(v.vaultId);
    });
    list.append(row);
  }
  popEl.append(list);

  popEl.append(Object.assign(document.createElement('div'), { className: styles.divider ?? '' }));

  const manage = document.createElement('button');
  manage.type = 'button';
  manage.className = styles.action ?? '';
  manage.innerHTML = `${iconSvg('Settings', 15)}<span>Manage spaces</span>`;
  manage.addEventListener('click', () => {
    closeVaultSwitcher();
    opts.onManage();
  });
  popEl.append(manage);

  document.body.append(popEl);

  // Anchor below the head row, flipping above if it would overflow — same
  // edge-flip math as the vanilla dropdown and `contextMenu.ts`.
  const a = opts.anchor;
  popEl.style.left = `${Math.max(8, a.left)}px`;
  let top = a.bottom + 6;
  if (top + popEl.offsetHeight > window.innerHeight - 8) {
    top = Math.max(8, a.top - popEl.offsetHeight - 6);
  }
  popEl.style.top = `${top}px`;
  const overflowRight = a.left + popEl.offsetWidth - window.innerWidth + 8;
  if (overflowRight > 0) popEl.style.left = `${Math.max(8, a.left - overflowRight)}px`;

  keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeVaultSwitcher();
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  (
    popEl.querySelector<HTMLElement>(`.${styles.row ?? ''}[data-active="true"]`) ??
    popEl.querySelector<HTMLElement>(`.${styles.row ?? ''}`)
  )?.focus();
}
