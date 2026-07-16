import toastCss from '../styles/toast.module.css';

// Undo toast (issue #420 §3) — a transient confirmation with an "Undo" action,
// the deferred-delete pattern claude.ai/Gmail use. Sibling of `showToast`: it
// portals to document.body and self-disposes. The caller does the destructive
// work optimistically (e.g. hide the row now); this toast owns the grace window
// and calls `onUndo` if the reader reverts, or `onExpire` when it lapses.

let undoToastEl: HTMLElement | null = null;
let undoTimer: ReturnType<typeof setTimeout> | null = null;
// The active toast's settler — a new toast commits the previous one (expire) so
// a rapid second delete never strands the first in limbo.
let activeFinish: ((undone: boolean) => void) | null = null;

function teardown(): void {
  if (undoTimer) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
  undoToastEl?.remove();
  undoToastEl = null;
  activeFinish = null;
}

export interface UndoToastOpts {
  /** Grace window before the action commits (default 6000ms). */
  durationMs?: number;
  /** Label on the action button (default "Undo"). */
  actionLabel?: string;
  /** Fired when the window lapses without an undo — commit the real action. */
  onExpire?: () => void;
}

export function showUndoToast(message: string, onUndo: () => void, opts: UndoToastOpts = {}): void {
  // Supersede any pending toast by committing it first.
  activeFinish?.(false);

  const toast = document.createElement('div');
  toast.className = toastCss.toast ?? '';
  toast.dataset.undoToast = 'true';

  const text = document.createElement('span');
  text.textContent = message;

  const action = document.createElement('button');
  action.type = 'button';
  action.textContent = opts.actionLabel ?? 'Undo';
  Object.assign(action.style, {
    background: 'transparent',
    border: '0',
    color: 'var(--accent)',
    cursor: 'pointer',
    font: 'inherit',
    fontWeight: '600',
    padding: '0 2px',
  });

  let settled = false;
  const finish = (undone: boolean): void => {
    if (settled) return;
    settled = true;
    teardown();
    if (undone) onUndo();
    else opts.onExpire?.();
  };

  action.addEventListener('click', () => finish(true));
  toast.append(text, action);

  Object.assign(toast.style, {
    left: '50%',
    position: 'fixed',
    top: '60px',
    transform: 'translateX(-50%)',
    zIndex: '90',
  });
  document.body.append(toast);
  undoToastEl = toast;
  activeFinish = finish;
  undoTimer = setTimeout(() => finish(false), opts.durationMs ?? 6000);
}
