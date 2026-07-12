import { tileFinish } from '@centraid/design-tokens';
import { iconSvg } from './iconSvg.js';
import { DEFAULT_SPACE_ICON, PROFILE_COLORS } from './routes/SpaceModal.js';
import type { FlatSwitcherRow, PairRow } from './flatVaultSwitcher-core.js';
import styles from './vaultSwitcher.module.css';

// Flat (gateway, vault) quick-switcher popover (issue #376, spec #289 §7) —
// ported from the vanilla profiles.ts `openDropdown`, then widened from
// "the active gateway's vaults" to every registered gateway's (gateway,
// vault) pairs in one list. A generic anchored body-portal overlay, same
// mechanics as `contextMenu.ts` (and for the same reason: the sidebar
// column clips `overflow: hidden` and, in themes with a blurred sidebar, a
// `backdrop-filter` establishes a containing block that would trap a plain
// `position: fixed` descendant — appending straight to `document.body`
// sidesteps both).
//
// This module is IO-free and knows nothing about gateways being reachable
// or not — it just renders whatever `FlatSwitcherRow[]` it's given
// (`flatVaultSwitcherRegistry.ts` owns the fetch/cache/merge that produces
// that list) and reports which pair got picked. `updateVaultSwitcherRows`
// patches an already-open popover's list in place, for the
// stale-while-revalidate refresh: rows stream in per-gateway without
// closing/reopening (and re-stealing focus/scroll) on every settle.
//
// Deliberately simplified vs. the vanilla dropdown: no per-row hover-reveal
// edit button and no inline add/rename/delete — those already have a home in
// the ported Settings → Spaces page (`SettingsProfilesScreen.tsx` +
// `SpaceModal.tsx`), so the popover's "Manage spaces" row links there instead
// of re-implementing the same modals in miniature.

export interface VaultSwitcherOpts {
  anchor: DOMRect;
  rows: FlatSwitcherRow[];
  onSelect: (row: PairRow) => void;
  onManage: () => void;
  /** Called once, however the popover closes (row pick, backdrop, Escape,
   *  or a subsequent open call) — lets the trigger button drop its
   *  `data-open` styling. */
  onClose?: () => void;
}

let backdropEl: HTMLElement | null = null;
let popEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let eyebrowEl: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let closeCb: (() => void) | null = null;
let selectCb: ((row: PairRow) => void) | null = null;

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
  listEl = null;
  eyebrowEl = null;
  selectCb = null;
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

function statusIconNode(status: 'loading' | 'unreachable' | 'auth_failed' | 'bad_response'): HTMLElement {
  const span = document.createElement('span');
  span.className = `${styles.avatar ?? ''} ${styles.avatarMuted ?? ''}`;
  span.innerHTML =
    status === 'loading' ? iconSvg('Loader', 15, 2) : iconSvg('AlertCircle', 15, 1.9);
  if (status === 'loading') span.classList.add(styles.spin ?? '');
  return span;
}

function statusText(status: 'loading' | 'unreachable' | 'auth_failed' | 'bad_response'): string {
  switch (status) {
    case 'loading':
      return 'Checking…';
    case 'auth_failed':
      return 'Sign-in required';
    case 'bad_response':
      return 'Unexpected response';
    default:
      return 'Offline';
  }
}

function buildPairRow(row: PairRow): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = styles.row ?? '';
  el.setAttribute('role', 'menuitem');
  el.dataset.active = String(row.isActive);
  el.append(avatarNode(row.color, row.icon));

  const text = document.createElement('span');
  text.className = styles.text ?? '';
  const nameEl = document.createElement('span');
  nameEl.className = styles.name ?? '';
  nameEl.textContent = row.name;
  text.append(nameEl);
  const sub = document.createElement('span');
  sub.className = styles.sub ?? '';
  sub.textContent = row.gatewayLabel;
  text.append(sub);
  el.append(text);

  const check = document.createElement('span');
  check.className = styles.check ?? '';
  if (row.isActive) check.innerHTML = iconSvg('Check', 14, 2.2);
  else if (row.gatewayRefreshing) check.innerHTML = iconSvg('Loader', 12, 2);
  if (row.gatewayRefreshing && !row.isActive) check.classList.add(styles.spin ?? '');
  el.append(check);

  el.addEventListener('click', () => {
    const select = selectCb;
    closeVaultSwitcher();
    if (!row.isActive) select?.(row);
  });
  return el;
}

function buildStatusRow(row: Extract<FlatSwitcherRow, { kind: 'gateway-status' }>): HTMLElement {
  const el = document.createElement('div');
  el.className = `${styles.row ?? ''} ${styles.rowDisabled ?? ''}`;
  el.setAttribute('role', 'menuitem');
  el.setAttribute('aria-disabled', 'true');
  el.append(statusIconNode(row.status));

  const text = document.createElement('span');
  text.className = styles.text ?? '';
  const nameEl = document.createElement('span');
  nameEl.className = styles.name ?? '';
  nameEl.textContent = row.gatewayLabel;
  text.append(nameEl);
  const sub = document.createElement('span');
  sub.className = styles.sub ?? '';
  sub.textContent = statusText(row.status);
  text.append(sub);
  el.append(text);
  return el;
}

function renderRows(rows: FlatSwitcherRow[]): void {
  if (!listEl) return;
  listEl.innerHTML = '';
  for (const row of rows) {
    listEl.append(row.kind === 'pair' ? buildPairRow(row) : buildStatusRow(row));
  }
  if (eyebrowEl) {
    const pairCount = rows.filter((r) => r.kind === 'pair').length;
    eyebrowEl.textContent = `Spaces · ${pairCount}`;
  }
}

/**
 * Patch an already-open popover's rows in place (stale-while-revalidate
 * refresh landing) — no-op if the popover isn't open, so a background
 * fetch settling after the owner already closed the popover is harmless.
 */
export function updateVaultSwitcherRows(rows: FlatSwitcherRow[]): void {
  if (!isVaultSwitcherOpen()) return;
  renderRows(rows);
}

export function openVaultSwitcher(opts: VaultSwitcherOpts): void {
  closeVaultSwitcher();
  closeCb = opts.onClose ?? null;
  selectCb = opts.onSelect;

  backdropEl = document.createElement('div');
  backdropEl.className = styles.scrim ?? '';
  backdropEl.addEventListener('click', () => closeVaultSwitcher());
  document.body.append(backdropEl);

  popEl = document.createElement('div');
  popEl.className = styles.pop ?? '';
  popEl.setAttribute('role', 'menu');

  eyebrowEl = document.createElement('div');
  eyebrowEl.className = styles.eyebrow ?? '';
  popEl.append(eyebrowEl);

  listEl = document.createElement('div');
  listEl.className = styles.list ?? '';
  popEl.append(listEl);
  renderRows(opts.rows);

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
