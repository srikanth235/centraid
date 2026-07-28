// React entry for the renderer — issue #325.
//
// React owns `#root`: this module mounts the App shell (via the first-run
// onboarding gate below). A dev-only component gallery renders on the
// `#ui-preview` hash. No vanilla↔React bridge remains — every screen, the
// builder included, is a React component the shell mounts directly.
//
// Bundled by Vite (see vite.config.ts) into dist/renderer/react-boot.js and
// loaded as a plain <script type="module"> — no dev server, so the strict
// `script-src 'self'` CSP holds.

import '../theme-vars.js';
import '../icons.js';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import {
  consumeInitialAssistHandoff,
  installDesktopAssistHandoff,
} from '../assist-oauth-handoff.js';
import { resetGatewayAuthCache } from '../gateway-client-core.js';
import {
  getGatewayFoundingStatus,
  initializeGatewayVault,
  restoreGatewayVault,
  verifyGatewayFoundingKit,
} from '../gateway-client-founding.js';
import FirstRunGate from './screens/FirstRunGate.js';
import App from './shell/App.js';
import ErrorBoundary from './shell/ErrorBoundary.js';
import { Gallery } from './ui/index.js';

// Install terminal replica cleanup before any AppFrame asks for a local read;
// inactive gateway removal and vault switches must also reach dormant storage.
void import('../replica/shell-session.js')
  .then((module) => module.installReplicaStorageLifecycle())
  .catch(() => undefined);

// Opted-in paired devices contribute PDF text and video posters only while
// charging + unmetered. Dynamic import keeps the PDF.js worker off the shell's
// startup path; the queue runner itself waits for browser idle time.
void import('../device-enrichment-worker.js')
  .then((module) => module.installDeviceEnrichmentWorker())
  .catch(() => undefined);

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
// React now owns #root: one root on #root renders either the first-run gate or
// the App shell, replacing the retired vanilla app.ts IIFE. An uninitialized
// gateway offers Create / Restore; a founded gateway only offers device
// onboarding. Both paths converge on the same persisted completion state.
void (async (): Promise<void> => {
  const shell = document.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell) return;
  // Calling this before render synchronously scrubs the sensitive fragment;
  // awaiting it later keeps a slow gateway exchange from blanking the PWA.
  const assistHandoffPromise = consumeInitialAssistHandoff();
  installDesktopAssistHandoff();
  const shellRoot = createRoot(shell);
  const settings = await window.CentraidApi.getSettings().catch(
    () => ({}) as Awaited<ReturnType<typeof window.CentraidApi.getSettings>>,
  );
  const wrap = (node: ReactNode) => (
    <ErrorBoundary title="Centraid hit a problem">{node}</ErrorBoundary>
  );
  if (settings.onboardingCompletedAt) {
    shellRoot.render(wrap(<App />));
    const assistHandoff = await assistHandoffPromise;
    if (assistHandoff.status === 'error') window.alert(assistHandoff.message);
    return;
  }
  void assistHandoffPromise.then((assistHandoff) => {
    if (assistHandoff.status === 'error') window.alert(assistHandoff.message);
  });
  const enterApp = async (): Promise<void> => {
    resetGatewayAuthCache();
    await window.CentraidApi.saveSettings({
      onboardingCompletedAt: new Date().toISOString(),
    }).catch(() => undefined);
    shellRoot.render(wrap(<App />));
  };
  const renderFirstRun = (
    gatewayStatus: 'uninitialized' | 'ready' | 'unreachable',
    foundingPending = false,
  ): void => {
    shellRoot.render(
      wrap(
        <FirstRunGate
          gatewayStatus={gatewayStatus}
          foundingPending={foundingPending}
          founding={{
            initialize: initializeGatewayVault,
            verify: verifyGatewayFoundingKit,
            restore: restoreGatewayVault,
          }}
          onFoundingComplete={enterApp}
          onOnboardingComplete={async ({ displayName, avatarColor, gatewayId }) => {
            // Write metadata to the gateway ConnectFlow actually connected. If
            // that gateway is still empty, continue into its founding ceremony
            // before persisting onboarding completion.
            await window.CentraidApi.updateProfileMetadata({
              id: gatewayId || 'local',
              displayName,
              avatarColor,
            }).catch(() => undefined);
            resetGatewayAuthCache();
            const founding = await getGatewayFoundingStatus().catch(() => undefined);
            if (founding?.status === 'uninitialized') {
              renderFirstRun('uninitialized', founding.foundingPending === true);
              return;
            }
            await enterApp();
          }}
        />,
      ),
    );
  };
  const initial = await getGatewayFoundingStatus().catch(() => undefined);
  renderFirstRun(initial?.status ?? 'unreachable', initial?.foundingPending === true);
})();

const READY_LOG = '[react] renderer ready — App on #root; open %s for the component gallery';
console.log(READY_LOG, PREVIEW_HASH); // governance: allow-repo-hygiene (#363) one-time boot-readiness marker, not leftover debug output
