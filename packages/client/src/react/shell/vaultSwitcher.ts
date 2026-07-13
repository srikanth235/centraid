import { tileFinish } from '@centraid/design-tokens';
import { iconSvg } from './iconSvg.js';
import { openMenu, type CtxItem } from './contextMenu.js';
import { DEFAULT_SPACE_ICON, PROFILE_COLORS } from './routes/SpaceModal.js';
import type { GroupedSwitcherGateway, PairRow } from './flatVaultSwitcher-core.js';
import styles from './vaultSwitcher.module.css';

// Grouped (gateway, vault) switcher popover (issue #382) — the single home
// for choosing AND managing pairs. Gateway header rows (label, transport
// badge, a slim leading status rail) with nested vault rows underneath,
// replacing the flat one-list-of-pairs popover from #376. Same body-portal
// mechanics as before (and `contextMenu.ts`, reused here for each gateway's
// overflow menu): the sidebar column clips `overflow: hidden` and a themed
// sidebar's `backdrop-filter` would trap a plain `position: fixed`
// descendant, so this appends straight to `document.body`.
//
// This module is IO-free — it renders whatever `GroupedSwitcherGateway[]`
// it's given (`flatVaultSwitcherRegistry.ts` owns the fetch/cache/merge) and
// reports which action got picked via callbacks. `updateVaultSwitcherRows`
// patches an already-open popover's list in place for the
// stale-while-revalidate refresh.

export interface VaultSwitcherOpts {
  anchor: DOMRect;
  groups: GroupedSwitcherGateway[];
  onSelectVault: (row: PairRow) => void;
  onAddGateway: () => void;
  /** "New space…" on a create-capable gateway's header. */
  onNewSpace: (gatewayId: string) => void;
  onTestConnection: (gatewayId: string) => void;
  onRenameGateway: (gatewayId: string) => void;
  /** Never offered for `'local'` — the overflow menu omits the item. */
  onRemoveGateway: (gatewayId: string) => void;
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
let opts: VaultSwitcherOpts | null = null;

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
  opts = null;
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
  span.innerHTML = iconSvg(icon ?? DEFAULT_SPACE_ICON, 14, 1.9);
  return span;
}

function statusText(status: GroupedSwitcherGateway['status']): string {
  switch (status) {
    case 'ready':
      return '';
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

/** The rail's data-status hook — `contextMenu.module.css`-adjacent styling
 *  reads `--pulse` off this, same convention as `GatewayScreen.module.css`. */
function railStatus(group: GroupedSwitcherGateway): 'ready' | 'loading' | 'error' {
  if (group.status === 'ready') return 'ready';
  if (group.status === 'loading') return 'loading';
  return 'error';
}

function buildVaultRow(row: PairRow, onSelect: (row: PairRow) => void): HTMLElement {
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
  if (row.blurb) {
    const sub = document.createElement('span');
    sub.className = styles.sub ?? '';
    sub.textContent = row.blurb;
    text.append(sub);
  }
  el.append(text);

  const check = document.createElement('span');
  check.className = styles.check ?? '';
  if (row.isActive) check.innerHTML = iconSvg('Check', 13, 2.2);
  el.append(check);

  el.addEventListener('click', () => {
    closeVaultSwitcher();
    if (!row.isActive) onSelect(row);
  });
  return el;
}

function buildGroup(group: GroupedSwitcherGateway, o: VaultSwitcherOpts): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = styles.group ?? '';
  wrap.dataset.gatewayId = group.gatewayId;

  const rail = document.createElement('span');
  rail.className = styles.rail ?? '';
  rail.dataset.status = railStatus(group);
  if (group.gatewayRefreshing) rail.dataset.pulse = 'true';
  wrap.append(rail);

  const body = document.createElement('div');
  body.className = styles.groupBody ?? '';
  wrap.append(body);

  const header = document.createElement('div');
  header.className = styles.header ?? '';
  body.append(header);

  const headText = document.createElement('span');
  headText.className = styles.headText ?? '';
  const headLabel = document.createElement('span');
  headLabel.className = styles.headLabel ?? '';
  headLabel.textContent = group.gatewayLabel;
  headText.append(headLabel);
  const headBadge = document.createElement('span');
  headBadge.className = styles.headBadge ?? '';
  headBadge.textContent = group.transportBadge;
  headText.append(headBadge);
  header.append(headText);

  const headActions = document.createElement('span');
  headActions.className = styles.headActions ?? '';
  if (group.canCreateVault) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = styles.headBtn ?? '';
    addBtn.title = 'New space…';
    addBtn.setAttribute('aria-label', `New space on ${group.gatewayLabel}`);
    addBtn.innerHTML = iconSvg('Plus', 13, 2);
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeVaultSwitcher();
      o.onNewSpace(group.gatewayId);
    });
    headActions.append(addBtn);
  }
  const moreBtn = document.createElement('button');
  moreBtn.type = 'button';
  moreBtn.className = styles.headBtn ?? '';
  moreBtn.title = 'More';
  moreBtn.setAttribute('aria-label', `More actions for ${group.gatewayLabel}`);
  moreBtn.innerHTML = iconSvg('MoreHoriz', 13, 2);
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const rect = moreBtn.getBoundingClientRect();
    const items: Array<CtxItem | 'sep'> = [
      { icon: 'Wifi', id: 'test', label: 'Test connection…' },
      { icon: 'Pencil', id: 'rename', label: 'Rename…' },
    ];
    // 'local' is the primordial gateway — never removable (mirrors
    // `removeGateway`'s own refusal + the retired Settings→Spaces list).
    if (group.gatewayKind !== 'local') {
      items.push('sep', { danger: true, icon: 'Trash', id: 'remove', label: 'Remove' });
    }
    // Close the switcher popover FIRST, same as every other switcher action
    // (New space…, Add gateway…, row selection) — `contextMenu.module.css`'s
    // z-index (70/71) sits well below the switcher's own scrim (1100/1101),
    // so leaving the switcher open behind this menu made every item
    // unclickable: the transparent-but-still-hit-testable scrim swallowed
    // the click before it ever reached "Test connection…"/"Rename…"/"Remove"
    // (found via live E2E, issue #382). `rect` is already captured above, so
    // closing first (which unmounts `moreBtn`) doesn't affect positioning.
    closeVaultSwitcher();
    openMenu(items, { kind: 'rect', rect }, (id) => {
      if (id === 'test') o.onTestConnection(group.gatewayId);
      else if (id === 'rename') o.onRenameGateway(group.gatewayId);
      else if (id === 'remove') o.onRemoveGateway(group.gatewayId);
    });
  });
  headActions.append(moreBtn);
  header.append(headActions);

  const vaultsEl = document.createElement('div');
  vaultsEl.className = styles.vaults ?? '';
  body.append(vaultsEl);
  for (const row of group.vaults) {
    vaultsEl.append(buildVaultRow(row, o.onSelectVault));
  }
  if (group.vaults.length === 0) {
    const status = document.createElement('div');
    status.className = styles.statusRow ?? '';
    status.textContent = statusText(group.status);
    vaultsEl.append(status);
  }

  return wrap;
}

function renderRows(): void {
  if (!listEl || !opts) return;
  listEl.innerHTML = '';
  for (const group of opts.groups) {
    listEl.append(buildGroup(group, opts));
  }
  if (eyebrowEl) {
    const pairCount = opts.groups.reduce((n, g) => n + g.vaults.length, 0);
    eyebrowEl.textContent = `Spaces · ${pairCount}`;
  }
}

/**
 * Patch an already-open popover's rows in place (stale-while-revalidate
 * refresh landing) — no-op if the popover isn't open, so a background
 * fetch settling after the owner already closed the popover is harmless.
 */
export function updateVaultSwitcherRows(groups: GroupedSwitcherGateway[]): void {
  if (!isVaultSwitcherOpen() || !opts) return;
  opts = { ...opts, groups };
  renderRows();
}

export function openVaultSwitcher(o: VaultSwitcherOpts): void {
  closeVaultSwitcher();
  opts = o;
  closeCb = o.onClose ?? null;

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
  renderRows();

  popEl.append(Object.assign(document.createElement('div'), { className: styles.divider ?? '' }));

  const add = document.createElement('button');
  add.type = 'button';
  add.className = styles.action ?? '';
  add.innerHTML = `${iconSvg('Plug', 15)}<span>Add gateway…</span>`;
  add.addEventListener('click', () => {
    closeVaultSwitcher();
    o.onAddGateway();
  });
  popEl.append(add);

  document.body.append(popEl);

  // Anchor below the head row, flipping above if it would overflow — same
  // edge-flip math as the vanilla dropdown and `contextMenu.ts`.
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
      closeVaultSwitcher();
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  (
    popEl.querySelector<HTMLElement>(`.${styles.row ?? ''}[data-active="true"]`) ??
    popEl.querySelector<HTMLElement>(`.${styles.row ?? ''}`)
  )?.focus();
}
