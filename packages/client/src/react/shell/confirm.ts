import { cx } from "../ui/cx.js";

import modalCss from "../styles/modal.module.css";
import buttonCss from "../ui/Button.module.css";
// Confirm dialog — a promise-based modal (backdrop + card + Cancel/Confirm,
// Esc = cancel, Enter = confirm for non-danger actions). It portals to document.body and resolves a
// boolean, so it's imperatively awaitable from any route regardless of who
// owns #root. Kept as a plain function (no React) because the promise/await
// ergonomics are what callers want.
//
// Uses a non-modal <dialog open> (not showModal) so the custom backdrop sibling
// stays clickable. Native showModal() top-layer would intercept pointer events
// and break backdrop dismiss (desktop e2e 3.5c).
//
// Danger actions intentionally omit the document-level Enter→confirm shortcut
// (accessibility contract). Confirm is still focused so a focused Enter
// activates the native button click (desktop e2e 3.5d delete-via-Enter).

const X_SVG =
  '<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function openConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const priorFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      backdrop.remove();
      if (card.open && typeof card.close === "function") card.close();
      card.remove();
      priorFocus?.focus();
      resolve(result);
    };

    const backdrop = document.createElement("div");
    backdrop.className = modalCss.backdrop ?? "";
    backdrop.dataset.testid = "modal-backdrop";
    backdrop.addEventListener("click", () => finish(false));

    const card = document.createElement("dialog");
    card.className = modalCss.card ?? "";
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", opts.title);
    card.setAttribute("open", "");
    card.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });

    const closeBtn = document.createElement("button");
    closeBtn.className = cx(buttonCss.icon, modalCss.close);
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.innerHTML = X_SVG;
    closeBtn.addEventListener("click", () => finish(false));

    const heading = document.createElement("h3");
    heading.textContent = opts.title;
    const body = document.createElement("p");
    body.textContent = opts.message;

    const cancelBtn = document.createElement("button");
    cancelBtn.className = cx(buttonCss.btn, buttonCss.ghost);
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => finish(false));

    const confirmBtn = document.createElement("button");
    confirmBtn.className = cx(
      buttonCss.btn,
      opts.danger ? modalCss.danger : buttonCss.primary
    );
    confirmBtn.textContent = opts.confirmLabel ?? "Confirm";
    confirmBtn.addEventListener("click", () => finish(true));

    const actions = document.createElement("div");
    actions.className = modalCss.actions ?? "";
    actions.append(cancelBtn, confirmBtn);
    card.append(closeBtn, heading, body, actions);

    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      } else if (e.key === "Enter" && !opts.danger) {
        e.preventDefault();
        finish(true);
      }
    }
    document.addEventListener("keydown", onKey);

    document.body.append(backdrop, card);
    // Always focus Confirm so Enter activates it natively (including danger).
    setTimeout(() => confirmBtn.focus(), 30);
  });
}
