import { buildVaultRows } from "./gatewayRegistry.js";
import type {
  GatewayRow,
  OwnerVaultScope,
  SwitcherVaultRow,
} from "./gatewayRegistry.js";
import { iconSvg } from "./iconSvg.js";

import styles from "./gatewaySwitcher.module.css";

// The sidebar switcher (#608, #665): VAULTS ONLY, flattened across gateways.
// A gateway is transport, not a pick — selecting a vault on another gateway
// switches both pointers. SWITCHES and nothing else; disconnect lives on
// Settings → Vault, host plumbing in Gateway → Components. Always reachable
// with one vault, so Add vault and its shortcut never hide.
//
// Body-portal: the sidebar clips `overflow: hidden`; `backdrop-filter` traps
// fixed descendants. IO-free; renders any `GatewayRow[]`
// (`gatewayRegistry.ts` owns fetch/cache/merge).

export interface GatewaySwitcherOpts {
  anchor: DOMRect;
  /** The active gateway's owner scopes — the only vaults whose OWNERSHIP is known. */
  scopes: ReadonlyArray<OwnerVaultScope>;
  activeGatewayId: string;
  rows: GatewayRow[];
  /** May differ from the active gateway: switch both then. */
  onSelectVault: (gatewayId: string, vaultId: string) => void;
  onAddGateway: () => void;
  /** Called once on close — drop `data-open` styling. */
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
    document.removeEventListener("keydown", keyHandler, true);
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

function buildRow(row: SwitcherVaultRow, o: GatewaySwitcherOpts): HTMLElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = styles.row ?? "";
  el.setAttribute("role", "menuitem");
  el.dataset.active = String(row.isActive);
  el.dataset.gatewayId = row.gatewayId;
  el.dataset.selectable = String(row.selectable);
  if (row.vaultId !== undefined) el.dataset.vaultId = row.vaultId;
  if (!row.selectable) el.disabled = true;

  const rail = document.createElement("span");
  rail.className = styles.rail ?? "";
  rail.dataset.status = row.status;

  const text = document.createElement("span");
  text.className = styles.text ?? "";
  const name = document.createElement("span");
  name.className = styles.name ?? "";
  name.textContent = row.label;
  const sub = document.createElement("span");
  sub.className = styles.sub ?? "";
  sub.textContent = row.subtitle;
  text.append(name, sub);

  const check = document.createElement("span");
  check.className = styles.check ?? "";
  if (row.isActive) check.innerHTML = iconSvg("Check", 13, 2.2);

  el.append(rail, text, check);
  el.addEventListener("click", () => {
    const vaultId = row.vaultId;
    closeGatewaySwitcher();
    if (!row.selectable || vaultId === undefined || row.isActive) return;
    o.onSelectVault(row.gatewayId, vaultId);
  });
  return el;
}

function renderRows(): void {
  if (!listEl || !opts) return;
  listEl.innerHTML = "";
  const rows = buildVaultRows(opts.rows, opts.scopes, opts.activeGatewayId);
  for (const row of rows) listEl.append(buildRow(row, opts));
}

/** Patch an open popover's rows in place; no-op when closed. */
export function updateGatewaySwitcherRows(rows: GatewayRow[]): void {
  if (!isGatewaySwitcherOpen() || !opts) return;
  opts = { ...opts, rows };
  renderRows();
}

export function openGatewaySwitcher(o: GatewaySwitcherOpts): void {
  closeGatewaySwitcher();
  opts = o;
  closeCb = o.onClose ?? null;

  backdropEl = document.createElement("div");
  backdropEl.className = styles.scrim ?? "";
  backdropEl.addEventListener("click", () => closeGatewaySwitcher());
  document.body.append(backdropEl);

  popEl = document.createElement("div");
  popEl.className = styles.pop ?? "";
  popEl.setAttribute("role", "menu");
  popEl.setAttribute("aria-label", "Vaults");

  const eyebrow = document.createElement("div");
  eyebrow.className = styles.eyebrow ?? "";
  eyebrow.textContent = "Vaults";
  popEl.append(eyebrow);

  listEl = document.createElement("div");
  listEl.className = styles.list ?? "";
  popEl.append(listEl);
  renderRows();

  popEl.append(
    Object.assign(document.createElement("div"), {
      className: styles.divider ?? "",
    })
  );

  const add = document.createElement("button");
  add.type = "button";
  add.className = styles.action ?? "";
  // "Add vault…": the member's words; same callback behind it.
  add.innerHTML = `${iconSvg("Plug", 15)}<span>Add vault…</span>`;
  add.addEventListener("click", () => {
    closeGatewaySwitcher();
    o.onAddGateway();
  });
  popEl.append(add);

  document.body.append(popEl);

  // Below the trigger, flipping above on overflow (as contextMenu.ts).
  const a = o.anchor;
  popEl.style.left = `${Math.max(8, a.left)}px`;
  let top = a.bottom + 6;
  if (top + popEl.offsetHeight > window.innerHeight - 8) {
    top = Math.max(8, a.top - popEl.offsetHeight - 6);
  }
  popEl.style.top = `${top}px`;
  const overflowRight = a.left + popEl.offsetWidth - window.innerWidth + 8;
  if (overflowRight > 0)
    popEl.style.left = `${Math.max(8, a.left - overflowRight)}px`;

  keyHandler = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeGatewaySwitcher();
    }
  };
  document.addEventListener("keydown", keyHandler, true);

  (
    popEl.querySelector<HTMLElement>(
      `.${styles.row ?? ""}[data-active="true"]`
    ) ?? popEl.querySelector<HTMLElement>(`.${styles.row ?? ""}`)
  )?.focus();
}
