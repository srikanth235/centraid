import { buildVaultRows } from "./gatewayRegistry.js";
import type {
  GatewayRow,
  MemberVaultScope,
  SwitcherVaultRow,
} from "./gatewayRegistry.js";
import { iconSvg } from "./iconSvg.js";

import styles from "./gatewaySwitcher.module.css";

// The sidebar switcher (issues #608, #665). It lists VAULTS ONLY, flattened
// across every registered gateway.
//
// A gateway is transport, not something the owner picks: a pairing ticket lands
// them in a vault and which gateway hosts it is not their problem. So the
// Gateways section is gone — picking a vault on another gateway switches both
// pointers in one click. This surface SWITCHES and nothing else (issue #665):
// no overflow menus, no management affordances on a row. Leaving a connection
// is a per-vault act on Settings → Vault ("On this device → Disconnect"), and
// host plumbing (rename / remove / test connection) lives in the Connections
// section of Gateway → Components.
//
// It is always reachable, even with one vault, so Add vault and the keyboard
// shortcut never disappear behind an inventory-count gate.
//
// Same body-portal mechanics as the popover it replaces: the sidebar column
// clips `overflow: hidden` and a themed sidebar's `backdrop-filter` would trap
// a plain `position: fixed` descendant, so this appends to `document.body`.
//
// The module is IO-free — it renders whatever `GatewayRow[]` it is given
// (`gatewayRegistry.ts` owns the fetch/cache/merge and the flattening) and
// reports picks through callbacks. `updateGatewaySwitcherRows` patches an open
// popover in place as the stale-while-revalidate probes land.

export interface GatewaySwitcherOpts {
  anchor: DOMRect;
  /** The active gateway's member scopes — the only vaults whose ROLE is known. */
  scopes: ReadonlyArray<MemberVaultScope>;
  activeGatewayId: string;
  rows: GatewayRow[];
  /** Pick a vault. `gatewayId` may differ from the active one, in which case
   *  the caller must switch gateway AND vault. */
  onSelectVault: (gatewayId: string, vaultId: string) => void;
  onAddGateway: () => void;
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
  // `data-vault-id` is the switcher's long-standing row hook (glossary: code
  // identifiers keep their `vault` names until a mechanical rename).
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
  // "Add vault…" in the member's words — the same onAddGateway callback and the
  // same modal behind it; a gateway is how a vault is reached, not the thing
  // the member thinks they are adding.
  add.innerHTML = `${iconSvg("Plug", 15)}<span>Add vault…</span>`;
  add.addEventListener("click", () => {
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
