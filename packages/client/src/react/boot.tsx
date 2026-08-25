// Loaded as a plain module script — no dev server, so `script-src 'self'` holds.

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

void import("../replica/shell-session.js")
  .then((module) => module.installReplicaStorageLifecycle())
  .catch(() => undefined);

// THE FETCH WAITS, not just the work (#838): a bare `void import(…)` at module
// scope still requests during boot, putting PDF.js on every cold-load
// waterfall. A background contributor touches no network in the first minute.
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

// A settings READ that fails is not a fresh install: swallowing it would offer
// "start fresh" over a populated vault. The read stays three-valued.
type SettingsRead =
  | {
      ok: true;
      settings: Awaited<ReturnType<typeof window.CentraidApi.getSettings>>;
    }
  | { ok: false; detail: string | undefined };

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
    console.error("[boot] reading settings failed", error);
    return { ok: false, detail: hostMessage(error) };
  }
}

void (async (): Promise<void> => {
  const shell = document.querySelector<HTMLElement>(SHELL_SELECTOR);
  if (!shell) return;
  const assistHandoffPromise = consumeInitialAssistHandoff();
  installDesktopAssistHandoff();
  const shellRoot = createRoot(shell);
  const wrap = (node: ReactNode) => (
    <ErrorBoundary title="Centraid hit a problem">{node}</ErrorBoundary>
  );
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
            await enterApp({ seedSampleOnFirstRun: true });
          }}
        />
      )
    );
  };

  // "Try again" must retry what failed: the host's supervisor gives up after a
  // few, so the retry clears that state and restarts the gateway first.
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
  // After first paint only: a modal over an unpainted window strands them.
  void assistHandoffPromise.then((assistHandoff) => {
    if (assistHandoff.status === "error") window.alert(assistHandoff.message);
  });
})();

const READY_LOG =
  "[react] renderer ready — App on #root; open %s for the component gallery";
console.log(READY_LOG, PREVIEW_HASH); // governance: allow-repo-hygiene (#363) one-time boot-readiness marker, not leftover debug output
