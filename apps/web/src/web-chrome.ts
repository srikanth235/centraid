import { loadSettingsPatch, subscribe, SETTINGS_EVENT } from "./web-state.js";

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "centraid.web.v1.install-dismissed-at";
/** Re-offer the install banner this many days after "Not now". */
const REOFFER_DAYS = 14;

function notice(kind: "install" | "offline", text: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = `web-notice web-notice-${kind}`;
  element.setAttribute("role", kind === "offline" ? "status" : "region");
  const label = document.createElement("span");
  label.textContent = text;
  element.append(label);
  document.body.append(element);
  return element;
}

function dismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const at = Number(raw);
    if (!Number.isFinite(at)) return false;
    const ageMs = Date.now() - at;
    return ageMs < REOFFER_DAYS * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()));
  } catch {
    /* private mode */
  }
}

let bannerEl: HTMLDivElement | null = null;

function showInstallBanner(event: InstallPromptEvent): void {
  if (bannerEl || dismissedRecently()) return;
  const banner = notice(
    "install",
    "Install Centraid for a focused, app-like workspace."
  );
  bannerEl = banner;
  const install = document.createElement("button");
  install.type = "button";
  install.textContent = "Install";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Not now";
  dismiss.className = "web-notice-quiet";
  install.addEventListener("click", () => {
    void event
      .prompt()
      .then(() => event.userChoice)
      .finally(() => {
        banner.remove();
        bannerEl = null;
      });
  });
  dismiss.addEventListener("click", () => {
    markDismissed();
    banner.remove();
    bannerEl = null;
  });
  banner.append(install, dismiss);
}

/** First run has no gateway yet, so "reconnect to your gateway" is nonsense
 *  copy over the welcome screen (issue #603 W6). The banner starts once the
 *  user has actually finished onboarding. */
function onboardingComplete(): boolean {
  return typeof loadSettingsPatch()["onboardingCompletedAt"] === "string";
}

export function installWebChrome(): void {
  const offline = notice(
    "offline",
    "Offline — Centraid reconnects to your gateway when the network returns."
  );
  const syncGateway = (snapshot?: {
    status?: "unknown" | "up" | "down";
  }): void => {
    offline.toggleAttribute(
      "data-visible",
      snapshot?.status === "down" && onboardingComplete()
    );
  };
  // The onboarding stamp is written through `saveSettingsPatch`, which
  // publishes this. Re-read the gateway-owned health snapshot so this chrome
  // and Gateway → Overview always use the same authority.
  subscribe(SETTINGS_EVENT, () => {
    void window.CentraidApi.getGatewayRuntime().then(syncGateway);
  });
  window.CentraidApi.onGatewayRuntime(syncGateway);
  void window.CentraidApi.getGatewayRuntime().then(syncGateway);

  // Keep listening across the session (not `{ once: true }`) so a later
  // re-offer after days, or a menu action, can still use the event.
  window.addEventListener("beforeinstallprompt", (raw) => {
    raw.preventDefault();
    const event = raw as InstallPromptEvent;
    if (!dismissedRecently()) showInstallBanner(event);
  });
}
