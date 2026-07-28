import { iconSvg } from './iconSvg.js';
import { openMenu, type CtxItem } from './contextMenu.js';
import type { GatewayRow } from './gatewayRegistry.js';
import styles from './gatewaySwitcher.module.css';

// Gateway switcher popover (issue #599, Decision 14) — what survives of the
// grouped (gateway, space) switcher. Spaces are no longer picked here: the
// Household page lists them and every creation flow names its own target, so
// the sidebar's identity row only ever answers "which gateway am I talking
// to", and it only opens this when more than one is registered.
//
// Same body-portal mechanics as the popover it replaces (and as
// `contextMenu.ts`, reused here for a row's overflow menu): the sidebar column
// clips `overflow: hidden` and a themed sidebar's `backdrop-filter` would trap
// a plain `position: fixed` descendant, so this appends to `document.body`.
//
// The module is IO-free — it renders whatever `GatewayRow[]` it is given
// (`gatewayRegistry.ts` owns the fetch/cache/merge) and reports picks through
// callbacks. `updateGatewaySwitcherRows` patches an open popover in place as
// the stale-while-revalidate probes land.

export interface GatewaySwitcherOpts {
  anchor: DOMRect;
  rows: GatewayRow[];
  onSelectGateway: (gatewayId: string) => void;
  onAddGateway: () => void;
  onTestConnection: (gatewayId: string) => void;
  onRenameGateway: (gatewayId: string) => void;
  /** Never offered for `'local'` — the overflow menu omits the item. */
  onRemoveGateway: (gatewayId: string) => void;
  /** Called once, however the popover closes (row pick, backdrop, Escape, or a
   *  subsequent open) — lets the trigger drop its `data-open` styling. */
  onClose?: () => void;
}

let backdropEl: HTMLElement | null = null;
let popEl: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let closeCb: (() => void) | null = null;
let opts: GatewaySwitcherOpts | null = null;

export function isGatewaySwitcherOpen(): boolean {
  return popEl !== null;
}

export function closeGatewaySwitcher(): void {
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  backdropEl?.remove();
  backdropEl = null;
  popEl?.remove();
  popEl = null;
  listEl = null;
  opts = null;
  const cb = closeCb;
  closeCb = null;
  cb?.();
}

function subtitleFor(row: GatewayRow): string {
  switch (row.status) {
    case 'loading':
      return 'Checking…';
    case 'auth_failed':
      return 'Sign-in required';
    case 'bad_response':
      return 'Unexpected response';
    case 'unreachable':
      return 'Offline';
    default:
      return row.spaceCount === undefined
        ? 'Connected'
        : `${row.spaceCount} ${row.spaceCount === 1 ? 'space' : 'spaces'}`;
  }
}

function railStatus(row: GatewayRow): 'ready' | 'loading' | 'error' {
  if (row.status === 'ready') return 'ready';
  if (row.status === 'loading') return 'loading';
  return 'error';
}

function buildRow(row: GatewayRow, o: GatewaySwitcherOpts): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = styles.row ?? '';
  el.setAttribute('role', 'menuitem');
  el.dataset.active = String(row.isActive);
  el.dataset.gatewayId = row.gatewayId;

  const rail = document.createElement('span');
  rail.className = styles.rail ?? '';
  rail.dataset.status = railStatus(row);
  el.append(rail);

  const text = document.createElement('span');
  text.className = styles.text ?? '';
  const nameEl = document.createElement('span');
  nameEl.className = styles.name ?? '';
  const labelEl = document.createElement('span');
  labelEl.textContent = row.gatewayLabel;
  nameEl.append(labelEl);
  const badge = document.createElement('span');
  badge.className = styles.badge ?? '';
  badge.textContent = row.transportBadge;
  nameEl.append(badge);
  text.append(nameEl);
  const sub = document.createElement('span');
  sub.className = styles.sub ?? '';
  sub.textContent = subtitleFor(row);
  text.append(sub);
  el.append(text);

  const more = document.createElement('span');
  more.className = styles.more ?? '';
  more.setAttribute('role', 'button');
  more.tabIndex = 0;
  more.title = 'More';
  more.setAttribute('aria-label', `More actions for ${row.gatewayLabel}`);
  more.innerHTML = iconSvg('MoreHoriz', 13, 2);
  const openMore = (e: Event): void => {
    e.stopPropagation();
    e.preventDefault();
    const rect = more.getBoundingClientRect();
    const items: Array<CtxItem | 'sep'> = [
      { icon: 'Wifi', id: 'test', label: 'Test connection…' },
      { icon: 'Pencil', id: 'rename', label: 'Rename…' },
    ];
    if (row.canRemove) {
      items.push('sep', { danger: true, icon: 'Trash', id: 'remove', label: 'Remove' });
    }
    // Close this popover FIRST: its scrim sits at z-index 1100 and the context
    // menu at 70/71, so leaving it open would swallow every click (found live
    // on the switcher this replaces, issue #382). `rect` is already captured.
    closeGatewaySwitcher();
    openMenu(items, { kind: 'rect', rect }, (id) => {
      if (id === 'test') o.onTestConnection(row.gatewayId);
      else if (id === 'rename') o.onRenameGateway(row.gatewayId);
      else if (id === 'remove') o.onRemoveGateway(row.gatewayId);
    });
  };
  more.addEventListener('click', openMore);
  el.append(more);

  const check = document.createElement('span');
  check.className = styles.check ?? '';
  if (row.isActive) check.innerHTML = iconSvg('Check', 13, 2.2);
  el.append(check);

  el.addEventListener('click', () => {
    closeGatewaySwitcher();
    if (!row.isActive) o.onSelectGateway(row.gatewayId);
  });
  return el;
}

function renderRows(): void {
  if (!listEl || !opts) return;
  listEl.innerHTML = '';
  for (const row of opts.rows) listEl.append(buildRow(row, opts));
}

/**
 * Patch an already-open popover's rows in place as a background probe settles —
 * a no-op when the popover is closed, so a late probe is harmless.
 */
export function updateGatewaySwitcherRows(rows: GatewayRow[]): void {
  if (!isGatewaySwitcherOpen() || !opts) return;
  opts = { ...opts, rows };
  renderRows();
}

export function openGatewaySwitcher(o: GatewaySwitcherOpts): void {
  closeGatewaySwitcher();
  opts = o;
  closeCb = o.onClose ?? null;

  backdropEl = document.createElement('div');
  backdropEl.className = styles.scrim ?? '';
  backdropEl.addEventListener('click', () => closeGatewaySwitcher());
  document.body.append(backdropEl);

  popEl = document.createElement('div');
  popEl.className = styles.pop ?? '';
  popEl.setAttribute('role', 'menu');
  popEl.setAttribute('aria-label', 'Gateways');

  const eyebrow = document.createElement('div');
  eyebrow.className = styles.eyebrow ?? '';
  eyebrow.textContent = 'Gateways';
  popEl.append(eyebrow);

  listEl = document.createElement('div');
  listEl.className = styles.list ?? '';
  popEl.append(listEl);
  renderRows();

  popEl.append(Object.assign(document.createElement('div'), { className: styles.divider ?? '' }));

  const add = document.createElement('button');
  add.type = 'button';
  add.className = styles.action ?? '';
  add.innerHTML = `${iconSvg('Plug', 15)}<span>Add gateway…</span>`;
  add.addEventListener('click', () => {
    closeGatewaySwitcher();
    o.onAddGateway();
  });
  popEl.append(add);

  document.body.append(popEl);

  // Anchor below the trigger, flipping above if it would overflow — the same
  // edge-flip math as `contextMenu.ts`.
  const a = o.anchor;
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
      closeGatewaySwitcher();
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  (
    popEl.querySelector<HTMLElement>(`.${styles.row ?? ''}[data-active="true"]`) ??
    popEl.querySelector<HTMLElement>(`.${styles.row ?? ''}`)
  )?.focus();
}
