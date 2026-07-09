// Global toast — a transient confirmation pinned to the top-center of the
// window. Ported from the vanilla app.ts `showToast`; it portals to
// document.body (not #root), so it works whether React or the vanilla shell
// owns the root. Kept as a plain function (no React) since it's imperative and
// self-disposing. Same `.preview-toast.global-toast` classes (global, in
// styles.css) so it looks identical.

let toastTimer: ReturnType<typeof setTimeout> | null = null;

const CHECK_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>';

export function showToast(message: string): void {
  document.querySelector('.global-toast')?.remove();
  if (toastTimer) clearTimeout(toastTimer);

  const toast = document.createElement('div');
  toast.className = 'preview-toast global-toast';
  const icon = document.createElement('span');
  icon.innerHTML = CHECK_SVG;
  const text = document.createElement('span');
  text.textContent = message;
  toast.append(icon, text);
  Object.assign(toast.style, {
    left: '50%',
    position: 'fixed',
    top: '60px',
    transform: 'translateX(-50%)',
    zIndex: '90',
  });
  document.body.append(toast);
  toastTimer = setTimeout(() => toast.remove(), 2000);
}
