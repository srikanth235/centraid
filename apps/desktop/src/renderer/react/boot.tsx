// React entry for the renderer — issue #325.
//
// Two jobs, both proving React runs *inside the live vanilla renderer* (same
// document, same styles.css, same design-tokens):
//
//   1. Phase 0 coexistence island — on the `#ui-preview` hash, hide the vanilla
//      shell (`#root`) and render the local UI Gallery as an
//      overlay; restore on any other hash. Non-destructive proof + preview
//      surface.
//   2. Phase 3 screen bridge — publish `window.CentraidReact`, the handoff seam
//      converted screens use (see ./bridge.ts). Each `mount<Screen>` renders a
//      React screen into a host the vanilla route module owns and returns an
//      unmount disposer the module registers as the page's cleanup.
//
// Bundled by Vite (see vite.config.ts) into dist/renderer/react-boot.js and
// loaded as a plain <script type="module"> — no dev server, so the strict
// `script-src 'self'` CSP holds.

import { createRoot, type Root } from 'react-dom/client';
import { Gallery } from './ui/index.js';
import App from './shell/App.js';
import type { CentraidReactBridge } from './bridge.js';
import BuilderChatPane from './screens/BuilderChatPane.js';
import OnboardingScreen from './screens/OnboardingScreen.js';

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

// ── The shell (#325 flip) ────────────────────────────────────────────────
// React now owns #root: mount the App shell here, replacing the retired vanilla
// app.ts IIFE. First-run gate — when onboarding hasn't completed we show the
// welcome view (window.Onboarding, itself React via the bridge) and mount the
// App only after the user submits, persisting their identity like app.ts did.
let shellMounted = false;
function mountShell(shell: HTMLElement): void {
  if (shellMounted) return;
  shellMounted = true;
  createRoot(shell).render(<App />);
}

void (async (): Promise<void> => {
  const shell = document.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell) return;
  const settings = await window.CentraidApi.getSettings().catch(
    () => ({}) as Awaited<ReturnType<typeof window.CentraidApi.getSettings>>,
  );
  if (!settings.onboardingCompletedAt && window.Onboarding) {
    window.Onboarding.mount({
      root: shell,
      onComplete: async ({ displayName, avatarColor }) => {
        await window.CentraidApi.updateProfileMetadata({ id: 'local', displayName, avatarColor }).catch(
          () => undefined,
        );
        await window.CentraidApi.saveSettings({
          onboardingCompletedAt: new Date().toISOString(),
        }).catch(() => undefined);
        mountShell(shell);
      },
    });
    return;
  }
  mountShell(shell);
})();

// Vanilla→React handoff bridge (#325 R4). After the flip only two vanilla hosts
// still embed a React screen: the builder window's chat pane and the first-run
// onboarding view. Every other screen is mounted directly by its shell route.
const bridge: CentraidReactBridge = {
  mountBuilderChat(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<BuilderChatPane {...props} />);
    return () => screenRoot.unmount();
  },
  mountOnboarding(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<OnboardingScreen {...props} />);
    return () => screenRoot.unmount();
  },
};
window.CentraidReact = bridge;

console.log('[react] renderer ready — App on #root; open %s for the component gallery', PREVIEW_HASH);
