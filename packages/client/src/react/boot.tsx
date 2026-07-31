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
import StartupErrorScreen from "./screens/StartupErrorScreen.js";
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

// ── Reading the settings, and admitting when we couldn't ─────────────────
// A settings READ that fails is not a fresh install. It used to be treated as
// one: `getSettings().catch(() => ({}))` produced an object with no
// `onboardingCompletedAt`, and the gate below cannot tell "this member has
// never onboarded" from "we have no idea whether they have". Live, on a
// fully-set-up Mac whose gateway could not be assessed (device-key custody
// mismatch; a lock the daemon never answered), that rendered the first-run
// "Start fresh on this Mac" chooser over a real, populated vault — an invitation
// to start over shown to someone whose data was fine the whole time.
//
// So the read is now three-valued at the call site: it either succeeded (and
// the stamp decides), or it failed (and we say so). There is no fourth
// behaviour where a failure quietly wears the shape of a success.
type SettingsRead =
  | {
      ok: true;
      settings: Awaited<ReturnType<typeof window.CentraidApi.getSettings>>;
    }
  | { ok: false; detail: string | undefined };

/** The host's message, minus Electron's IPC wrapper — a member should not be
 *  reading `Error invoking remote method 'settings:get':` back to anyone. */
function hostMessage(error: unknown): string | undefined {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  const unwrapped = raw
    .replace(/^Error invoking remote method '[^']*':\s*/u, "")
    .replace(/^Error:\s*/u, "")
    .trim();
  return unwrapped.length > 0 ? unwrapped : undefined;
}

async function readSettings(): Promise<SettingsRead> {
  try {
    return { ok: true, settings: await window.CentraidApi.getSettings() };
  } catch (error) {
    // Logged, not swallowed: the renderer console is the first place anyone
    // debugging a stuck launch looks (docs/logs.md).
    console.error("[boot] reading settings failed", error);
    return { ok: false, detail: hostMessage(error) };
  }
}

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
  const wrap = (node: ReactNode) => (
    <ErrorBoundary title="Centraid hit a problem">{node}</ErrorBoundary>
  );
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
  const renderFirstRun = (): void => {
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
            if (path === "fresh" && vaultId && ownerVault && displayName) {
              // The auto-founded owner vault ships as "Personal"; first run
              // makes it theirs. `ownerVault` is false when this run landed on
              // a reinstall's existing data, where the fallback vault is the
              // SHARED one — renaming that would rename everyone's space
              // (issue #603 C10). Deliberately non-fatal — the user is already
              // in, and a generically-named space is a cosmetic problem they
              // can fix in Settings, not a reason to block onboarding. Logged
              // rather than swallowed so it is diagnosable. Gated on a non-empty
              // `displayName` because the gateway rejects a blank vault name —
              // a run that never asked for one must leave "Personal" alone.
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
  };

  // One attempt at deciding what to paint, retried by the startup error
  // screen: a retry that succeeds lands on exactly the same branches a first
  // attempt would, so there is no second, drifting boot path.
  //
  // "Try again" has to retry the thing that actually failed. The settings read
  // fails on this desktop because the local gateway would not start, and after
  // a few failures the host's supervisor gives up: from then on every read
  // fails INSTANTLY with the same message, whatever the member has since
  // fixed. So re-reading alone was a button that could never work — verified
  // by removing the cause completely (killing the process holding gateway.db;
  // restoring the device credential file) and pressing it.
  //
  // The retry therefore asks the host to clear that give-up state and start
  // the gateway again before reading. Deliberately best-effort: a host with no
  // local gateway of its own (the web PWA) has nothing to retry and simply
  // re-reads, and a retry that fails is not reported from here — the read then
  // fails again with the host's current words, which is the honest, up-to-date
  // message to put on the screen.
  const start = async (): Promise<void> => {
    const read = await readSettings();
    if (!read.ok) {
      shellRoot.render(
        wrap(
          <StartupErrorScreen
            detail={read.detail}
            onRetry={async () => {
              try {
                await window.CentraidApi.retryGatewayStart?.();
              } catch (error) {
                console.error(
                  "[boot] retrying the local gateway start failed",
                  error
                );
              }
              await start();
            }}
          />
        )
      );
      return;
    }
    if (read.settings.onboardingCompletedAt) {
      shellRoot.render(wrap(<App />));
      return;
    }
    renderFirstRun();
  };
  await start();
  // After the first paint, never before it — an assist handoff error opens a
  // blocking dialog, and a modal over an unpainted window is how the desktop
  // used to strand people with nothing to look at.
  void assistHandoffPromise.then((assistHandoff) => {
    if (assistHandoff.status === "error") window.alert(assistHandoff.message);
  });
})();

const READY_LOG =
  "[react] renderer ready — App on #root; open %s for the component gallery";
console.log(READY_LOG, PREVIEW_HASH); // governance: allow-repo-hygiene (#363) one-time boot-readiness marker, not leftover debug output
