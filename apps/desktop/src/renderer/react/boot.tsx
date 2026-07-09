// React entry for the renderer — issue #325.
//
// React owns `#root`: this module mounts the App shell (via the first-run
// onboarding gate below) and publishes `window.CentraidReact`, the one handoff
// seam still standing — the vanilla builder window hosts the React chat pane
// through it (see ./bridge.ts). A dev-only component gallery renders on the
// `#ui-preview` hash.
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
// React now owns #root: one root on #root renders either the first-run
// onboarding view or the App shell, replacing the retired vanilla app.ts IIFE.
// First-run gate — when onboarding hasn't completed we render the welcome view
// and swap the same root to <App/> once the user submits, persisting their
// identity like app.ts did.
void (async (): Promise<void> => {
  const shell = document.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell) return;
  const shellRoot = createRoot(shell);
  const settings = await window.CentraidApi.getSettings().catch(
    () => ({}) as Awaited<ReturnType<typeof window.CentraidApi.getSettings>>,
  );
  if (settings.onboardingCompletedAt) {
    shellRoot.render(<App />);
    return;
  }
  shellRoot.render(
    <OnboardingScreen
      onComplete={async ({ displayName, avatarColor }) => {
        await window.CentraidApi.updateProfileMetadata({ id: 'local', displayName, avatarColor }).catch(
          () => undefined,
        );
        await window.CentraidApi.saveSettings({
          onboardingCompletedAt: new Date().toISOString(),
        }).catch(() => undefined);
        shellRoot.render(<App />);
      }}
    />,
  );
})();

// Vanilla→React handoff bridge (#325 R4). After the flip the only vanilla host
// still embedding a React screen is the builder window's chat pane. Every other
// screen is mounted directly by its shell route or the boot sequence above.
const bridge: CentraidReactBridge = {
  mountBuilderChat(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<BuilderChatPane {...props} />);
    return () => screenRoot.unmount();
  },
};
window.CentraidReact = bridge;

console.log('[react] renderer ready — App on #root; open %s for the component gallery', PREVIEW_HASH);
