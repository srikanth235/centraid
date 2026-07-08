// React coexistence island — issue #325, Phase 0.
//
// This is the proof (and the seam) that React renders *inside the live
// vanilla renderer*: same document, same styles.css, same design-tokens.
// It is deliberately non-destructive — the vanilla shell owns `#root` and is
// never touched. When the URL hash is `#ui-preview`, this island hides the
// vanilla shell and renders the @centraid/desktop-ui component Gallery as a
// full-window overlay; on any other hash it unmounts and restores the shell.
//
// Screen-by-screen migration (Phases 3–4) grows out of this file: each screen
// converts by mounting its React tree into its own island the same way, while
// the rest of the shell stays vanilla and runnable.
//
// Bundled by Vite (see vite.config.ts) into dist/renderer/react-boot.js and
// loaded as a plain <script type="module"> — no dev server, so the strict
// `script-src 'self'` CSP holds.

import { createRoot, type Root } from 'react-dom/client';
import { Gallery } from '@centraid/desktop-ui';

const PREVIEW_HASH = '#ui-preview';
const HOST_SELECTOR = '#react-preview-root';
const SHELL_SELECTOR = '#root';

let root: Root | null = null;

function styleHost(host: HTMLElement): void {
  const s = host.style;
  s.position = 'fixed';
  s.inset = '0';
  s.overflow = 'auto';
  s.zIndex = '9999';
  s.background = 'var(--bg, #0f1115)';
  // Leave room for the traffic-light inset title bar on macOS.
  s.paddingTop = '28px';
}

function sync(): void {
  const host = document.querySelector<HTMLElement>(HOST_SELECTOR);
  if (!host) {
    return;
  }
  const shell = document.querySelector<HTMLElement>(SHELL_SELECTOR);
  const active = window.location.hash === PREVIEW_HASH;

  if (active) {
    styleHost(host);
    host.style.display = 'block';
    if (shell) {
      shell.style.display = 'none';
    }
    root ??= createRoot(host);
    root.render(<Gallery />);
    return;
  }

  host.style.display = 'none';
  if (shell) {
    shell.style.display = '';
  }
  if (root) {
    root.unmount();
    root = null;
  }
}

window.addEventListener('hashchange', sync);
sync();

console.log(
  '[react] desktop-ui island ready — open %s to preview the component gallery',
  PREVIEW_HASH,
);
