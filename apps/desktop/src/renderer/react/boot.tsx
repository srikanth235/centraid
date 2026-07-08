// React entry for the renderer — issue #325.
//
// Two jobs, both proving React runs *inside the live vanilla renderer* (same
// document, same styles.css, same design-tokens):
//
//   1. Phase 0 coexistence island — on the `#ui-preview` hash, hide the vanilla
//      shell (`#root`) and render the @centraid/desktop-ui Gallery as an
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
import { Gallery } from '@centraid/desktop-ui';
import type { CentraidReactBridge } from './bridge.js';
import AutomationsOverviewScreen from './screens/AutomationsOverviewScreen.js';
import AutomationTemplatesScreen from './screens/AutomationTemplatesScreen.js';
import AutomationViewScreen from './screens/AutomationViewScreen.js';
import DiscoverScreen from './screens/DiscoverScreen.js';
import ImportScreen from './screens/ImportScreen.js';
import InsightsScreen from './screens/InsightsScreen.js';
import OnboardingScreen from './screens/OnboardingScreen.js';
import PaletteScreen from './screens/PaletteScreen.js';
import PhoneScreen from './screens/PhoneScreen.js';
import SettingsAppearanceScreen from './screens/SettingsAppearanceScreen.js';
import SettingsLayoutScreen from './screens/SettingsLayoutScreen.js';
import VaultScreen from './screens/VaultScreen.js';

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

// Phase 3 bridge — the vanilla route modules delegate converted screens here.
const bridge: CentraidReactBridge = {
  mountDiscover(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<DiscoverScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountInsights(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<InsightsScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountVault(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<VaultScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountAutomationTemplates(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<AutomationTemplatesScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountAutomationsOverview(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<AutomationsOverviewScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountAutomationView(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<AutomationViewScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountPalette(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<PaletteScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountPhone(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<PhoneScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountImport(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<ImportScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountOnboarding(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<OnboardingScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountSettingsAppearance(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<SettingsAppearanceScreen {...props} />);
    return () => screenRoot.unmount();
  },
  mountSettingsLayout(host, props) {
    const screenRoot = createRoot(host);
    screenRoot.render(<SettingsLayoutScreen {...props} />);
    return () => screenRoot.unmount();
  },
};
window.CentraidReact = bridge;

console.log(
  '[react] renderer bridge ready — screens: discover, insights, vault; open %s for the component gallery',
  PREVIEW_HASH,
);
