// Confirm dialog — a promise-based modal (backdrop + card + Cancel/Confirm,
// Esc = cancel, Enter = confirm). Ported from the vanilla app-cards.ts
// `openConfirm`; it portals to document.body and resolves a boolean, so it's
// imperatively awaitable from any route regardless of who owns #root. Same
// global modal classes (in styles.css). Kept as a plain function (no React)
// because the promise/await ergonomics are what callers want.

const X_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export interface ConfirmOpts {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
}

export function openConfirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      card.remove();
      resolve(result);
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => finish(false));

    const card = document.createElement('div');
    card.className = 'modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', opts.title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-icon modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = X_SVG;
    closeBtn.addEventListener('click', () => finish(false));

    const heading = document.createElement('h3');
    heading.textContent = opts.title;
    const body = document.createElement('p');
    body.textContent = opts.message;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => finish(false));

    const confirmBtn = document.createElement('button');
    confirmBtn.className = opts.danger ? 'btn btn-danger' : 'btn btn-primary';
    confirmBtn.textContent = opts.confirmLabel ?? 'Confirm';
    confirmBtn.addEventListener('click', () => finish(true));

    const actions = document.createElement('div');
    actions.className = 'sheet-actions';
    actions.append(cancelBtn, confirmBtn);
    card.append(closeBtn, heading, body, actions);

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      }
    }
    document.addEventListener('keydown', onKey);

    document.body.append(backdrop, card);
    setTimeout(() => confirmBtn.focus(), 30);
  });
}
