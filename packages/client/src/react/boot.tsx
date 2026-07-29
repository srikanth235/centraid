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

import "../theme-vars.js";
import "../icons.js";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import {
  consumeInitialAssistHandoff,
  installDesktopAssistHandoff,
} from "../assist-oauth-handoff.js";
import { resetGatewayAuthCache } from "../gateway-client-core.js";
import { renameGatewayMember } from "../gateway-client-members.js";
import { updateVault } from "../gateway-client-vault.js";
import { isWebHost } from "./host-platform.js";
import FirstRunGate from "./screens/FirstRunGate.js";
import App from "./shell/App.js";
import ErrorBoundary from "./shell/ErrorBoundary.js";
import { Gallery } from "./ui/index.js";

// Install terminal replica cleanup before any AppFrame asks for a local read;
// inactive gateway removal and vault switches must also reach dormant storage.
void import("../replica/shell-session.js")
  .then((module) => module.installReplicaStorageLifecycle())
  .catch(() => undefined);

// Opted-in paired devices contribute PDF text and video posters only while
// charging + unmetered. Dynamic import keeps the PDF.js worker off the shell's
// startup path; the queue runner itself waits for browser idle time.
void import("../device-enrichment-worker.js")
  .then((module) => module.installDeviceEnrichmentWorker())
  .catch(() => undefined);

const PREVIEW_HASH = "#ui-preview";
const HOST_SELECTOR = "#react-preview-root";
const SHELL_SELECTOR = "#root";

let root: Root | null = null;

function styleHost(host: HTMLElement): void {
  const s = host.style;
  s.position = "fixed";
  s.inset = "0";
  s.overflow = "auto";
  s.zIndex = "9999";
  s.background = "var(--bg, #0f1115)";
  // Leave room for the traffic-light inset title bar on macOS.
  s.paddingTop = "28px";
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
    host.style.display = "block";
    if (shell) {
      shell.style.display = "none";
    }
    root ??= createRoot(host);
    root.render(<Gallery />);
    return;
  }

  host.style.display = "none";
  if (shell) {
    shell.style.display = "";
  }
  if (root) {
    root.unmount();
    root = null;
  }
}

window.addEventListener("hashchange", sync);
sync();

// ── The shell (#325 flip) ────────────────────────────────────────────────
// React owns #root: one root on #root renders either the first-run gate or
// the App shell, replacing the retired vanilla app.ts IIFE. First paint no
// longer probes the gateway (issue #603 deleted the founding plane): the gate
// decides on platform + the persisted onboarding stamp alone.
void (async (): Promise<void> => {
  const shell = document.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell) return;
  // Calling this before render synchronously scrubs the sensitive fragment;
  // awaiting it later keeps a slow gateway exchange from blanking the PWA.
  const assistHandoffPromise = consumeInitialAssistHandoff();
  installDesktopAssistHandoff();
  const shellRoot = createRoot(shell);
  const settings = await window.CentraidApi.getSettings().catch(
    () => ({}) as Awaited<ReturnType<typeof window.CentraidApi.getSettings>>
  );
  const wrap = (node: ReactNode) => (
    <ErrorBoundary title="Centraid hit a problem">{node}</ErrorBoundary>
  );
  if (settings.onboardingCompletedAt) {
    shellRoot.render(wrap(<App />));
    const assistHandoff = await assistHandoffPromise;
    if (assistHandoff.status === "error") window.alert(assistHandoff.message);
    return;
  }
  void assistHandoffPromise.then((assistHandoff) => {
    if (assistHandoff.status === "error") window.alert(assistHandoff.message);
  });
  // Both throws are deliberate: OnboardingScreen catches whatever
  // `onOnboardingComplete` rejects with and renders it inline, so a failed
  // profile write or settings save shows up instead of silently stranding the
  // user on a "completed" first run that never persisted.
  const enterApp = async (): Promise<void> => {
    resetGatewayAuthCache();
    await window.CentraidApi.saveSettings({
      onboardingCompletedAt: new Date().toISOString(),
    });
    shellRoot.render(wrap(<App />));
  };
  shellRoot.render(
    wrap(
      <FirstRunGate
        host={isWebHost() ? "web" : "desktop"}
        onOnboardingComplete={async ({
          displayName,
          avatarColor,
          gatewayId,
          vaultId,
          ownerVault,
          memberId,
          path,
        }) => {
          // Write metadata to the gateway this run actually connected.
          await window.CentraidApi.updateProfileMetadata({
            id: gatewayId || "local",
            displayName,
            avatarColor,
          });
          // The name belongs to the PERSON: without this it lived only in
          // device-local settings, invisible to every surface, and Household
          // kept showing the placeholder "You". `memberId` is set only when
          // onboarding actually asked, so a returning device never renames
          // someone who already has a name. Non-fatal for the same reason the
          // vault rename below is: the user is already in.
          if (memberId && displayName) {
            await renameGatewayMember(memberId, displayName).catch(
              (error: unknown) => {
                console.error(
                  "[first-run] naming the household member failed",
                  error
                );
              }
            );
          }
          resetGatewayAuthCache();
          if (path === "fresh" && vaultId && ownerVault) {
            // The auto-founded owner vault ships as "Personal"; first run
            // makes it theirs. `ownerVault` is false when this run landed on
            // a reinstall's existing data, where the fallback vault is the
            // SHARED one — renaming that would rename everyone's space
            // (issue #603 C10). Deliberately non-fatal — the user is already
            // in, and a generically-named space is a cosmetic problem they
            // can fix in Settings, not a reason to block onboarding. Logged
            // rather than swallowed so it is diagnosable.
            await updateVault({
              vaultId,
              name: displayName,
              color: avatarColor,
            }).catch((error: unknown) => {
              console.error(
                "[first-run] renaming the Personal vault failed",
                error
              );
            });
          }
          await enterApp();
        }}
      />
    )
  );
})();

const READY_LOG =
  "[react] renderer ready — App on #root; open %s for the component gallery";
console.log(READY_LOG, PREVIEW_HASH); // governance: allow-repo-hygiene (#363) one-time boot-readiness marker, not leftover debug output
