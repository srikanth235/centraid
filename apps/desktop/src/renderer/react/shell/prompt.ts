// Text-prompt dialog — a promise-based modal (backdrop + card + a single text
// field + Cancel/Save, Esc = cancel, Enter = save). Sibling of confirm.ts's
// `openConfirm`; it portals to document.body and resolves the trimmed string, or
// null when cancelled/emptied/unchanged, so it's imperatively awaitable from any
// route. Reuses the same global modal classes in styles.css. Kept as a plain
// function (no React) for the same await ergonomics as openConfirm.

const X_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export interface PromptOpts {
  title: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
}

export function openPrompt(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      card.remove();
      resolve(result);
    };
    // The trimmed field value, or null when empty or unchanged from the initial.
    const commit = (): void => {
      const next = input.value.trim();
      finish(next && next !== (opts.initial ?? '').trim() ? next : null);
    };

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.addEventListener('click', () => finish(null));

    const card = document.createElement('div');
    card.className = 'modal-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', opts.title);

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-icon modal-close';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = X_SVG;
    closeBtn.addEventListener('click', () => finish(null));

    const heading = document.createElement('h3');
    heading.textContent = opts.title;

    const input = document.createElement('input');
    input.className = 'modal-input';
    input.type = 'text';
    input.value = opts.initial ?? '';
    if (opts.placeholder) input.placeholder = opts.placeholder;

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-ghost';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', () => finish(null));

    const saveBtn = document.createElement('button');
    saveBtn.className = 'btn btn-primary';
    saveBtn.textContent = opts.confirmLabel ?? 'Save';
    saveBtn.addEventListener('click', commit);

    const actions = document.createElement('div');
    actions.className = 'sheet-actions';
    actions.append(cancelBtn, saveBtn);
    card.append(closeBtn, heading, input, actions);

    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        commit();
      }
    }
    document.addEventListener('keydown', onKey);

    document.body.append(backdrop, card);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}
