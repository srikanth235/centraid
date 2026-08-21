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
import { isWebHost } from "./host-platform.js";
import FirstRunGate from "./screens/FirstRunGate.js";
import StartupErrorScreen from "./screens/StartupErrorScreen.js";
import App from "./shell/App.js";
import ErrorBoundary from "./shell/ErrorBoundary.js";
import { Gallery } from "./ui/index.js";

// Install terminal replica cleanup before any app route asks for a local read;
// inactive gateway removal and vault switches must also reach dormant storage.
void import("../replica/shell-session.js")
  .then((module) => module.installReplicaStorageLifecycle())
  .catch(() => undefined);

// Opted-in paired devices contribute PDF text and video posters only while
// charging + unmetered. THE FETCH WAITS, not just the work (issue #838).
//
// This was a bare `void import(…)` under a comment claiming the dynamic import
// kept PDF.js off the shell's startup path. Dynamic and immediate are
// different things: the request went out during boot, so the worker chunk and
// the `pdf.worker.min` asset it pulls were on the cold-load waterfall of every
// seat — two same-origin requests the shell's own budget was paying for work
// that had not started and, on most seats, never would.
//
// A BACKGROUND CONTRIBUTOR DOES NOT TOUCH THE NETWORK IN THE FIRST MINUTE OF A
// SESSION. That is the rule the delay expresses, and it is the feature's own
// terms rather than a number tuned to a fence: this runner leases work only
// while the machine is on mains power and unmetered, then polls every five
// minutes (`POLL_INTERVAL_MS`) and waits for browser idle before computing
// anything. Against that cadence a first load one minute in is prompt, and
// nothing in the shell needs the module's code before then.
//
// It also keeps the cost off BOTH ends of a fresh session, not just the first
// paint: fetched at ten seconds the bytes simply moved from the cold sample to
// the reload that follows it, which is the same session paying the same price
// a moment later.
//
// The charging/unmetered gate stays where it belongs, inside the runner: it is
// a live condition to re-check on every attempt, not a fact to sample once at
// boot (and `navigator.getBattery()` answers `charging: true` on a mains-
// powered desktop, so it is not the thing keeping this off the waterfall).
const DEVICE_WORK_LOAD_DELAY_MS = 60_000;
window.setTimeout(() => {
  void import("../device-enrichment-worker.js")
    .then((module) => module.installDeviceEnrichmentWorker())
    .catch(() => undefined);
}, DEVICE_WORK_LOAD_DELAY_MS);

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
  // settings save shows up instead of silently stranding the user on a
  // "completed" first run that never persisted.
  const enterApp = async (options?: {
    seedSampleOnFirstRun?: boolean;
  }): Promise<void> => {
    resetGatewayAuthCache();
    await window.CentraidApi.saveSettings({
      onboardingCompletedAt: new Date().toISOString(),
    });
    shellRoot.render(
      wrap(<App seedSampleOnFirstRun={options?.seedSampleOnFirstRun} />)
    );
  };
  const renderFirstRun = (): void => {
    shellRoot.render(
      wrap(
        <FirstRunGate
          host={isWebHost() ? "web" : "desktop"}
          onOnboardingComplete={async () => {
            // Profile details are deliberately deferred to Settings → You.
            // The first visit should get straight to the useful surface, with
            // a removable sample week already being prepared there.
            await enterApp({ seedSampleOnFirstRun: true });
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
