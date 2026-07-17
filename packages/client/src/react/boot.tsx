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
import { createRoot, type Root } from 'react-dom/client';
import { Gallery } from './ui/index.js';
import App from './shell/App.js';
import FirstRunGate from './screens/FirstRunGate.js';
import { resetGatewayAuthCache } from '../gateway-client-core.js';
import {
  discoverRecovery,
  getRecoverStatus,
  startRecovery,
  streamRecoverEvents,
  validateRecoveryKit,
} from '../gateway-client-recover.js';

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
// React now owns #root: one root on #root renders either the first-run gate
// (the "Start fresh / Recover my vault" choice, issue #439) or the App shell,
// replacing the retired vanilla app.ts IIFE. When onboarding hasn't completed
// we render the gate and swap the same root to <App/> once either path finishes.
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
    <FirstRunGate
      recover={{
        validateKit: validateRecoveryKit,
        discover: discoverRecovery,
        start: startRecovery,
        status: getRecoverStatus,
        streamEvents: streamRecoverEvents,
      }}
      onOnboardingComplete={async ({ displayName, avatarColor, gatewayId }) => {
        // issue #382 fix: write the name/color to the profile of the
        // gateway ConnectFlow actually connected — pairing a remote gateway
        // during onboarding used to always land on 'local', leaving the
        // gateway the user just connected to with no display name/color.
        await window.CentraidApi.updateProfileMetadata({
          id: gatewayId || 'local',
          displayName,
          avatarColor,
        }).catch(() => undefined);
        await window.CentraidApi.saveSettings({
          onboardingCompletedAt: new Date().toISOString(),
        }).catch(() => undefined);
        shellRoot.render(<App />);
      }}
      onRecoveryComplete={async () => {
        // The gateway (local embedded on desktop, or the connected gateway on
        // web) already mounted the recovered vault in-process — the adopt fired
        // on first mount and the quarantine parked. The RECOVER path skips
        // identity/connect: the recovered vault already carries its own profile,
        // so there's no updateProfileMetadata here. Drop the cached pre-vault
        // auth so the next read addresses the recovered vault the gateway now
        // serves (its vaultId is undefined on a fresh install ⇒ the gateway
        // picks, and the only mounted vault is the recovered one), stamp
        // onboarding done, and boot the app against it — same terminal state as
        // the fresh path.
        resetGatewayAuthCache();
        await window.CentraidApi.saveSettings({
          onboardingCompletedAt: new Date().toISOString(),
        }).catch(() => undefined);
        shellRoot.render(<App />);
      }}
    />,
  );
})();

const READY_LOG = '[react] renderer ready — App on #root; open %s for the component gallery';
console.log(READY_LOG, PREVIEW_HASH); // governance: allow-repo-hygiene (#363) one-time boot-readiness marker, not leftover debug output
