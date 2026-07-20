interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const DISMISS_KEY = 'centraid.web.v1.install-dismissed-at';
/** Re-offer the install banner this many days after "Not now". */
const REOFFER_DAYS = 14;

function notice(kind: 'install' | 'offline', text: string): HTMLDivElement {
  const element = document.createElement('div');
  element.className = `web-notice web-notice-${kind}`;
  element.setAttribute('role', kind === 'offline' ? 'status' : 'region');
  const label = document.createElement('span');
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

/** Clear dismiss so a settings/menu action can re-offer immediately. */
export function reofferInstallPrompt(): void {
  try {
    localStorage.removeItem(DISMISS_KEY);
  } catch {
    /* private mode */
  }
}

let deferredPrompt: InstallPromptEvent | null = null;
let bannerEl: HTMLDivElement | null = null;

function showInstallBanner(event: InstallPromptEvent): void {
  if (bannerEl || dismissedRecently()) return;
  deferredPrompt = event;
  const banner = notice('install', 'Install Centraid for a focused, app-like workspace.');
  bannerEl = banner;
  const install = document.createElement('button');
  install.type = 'button';
  install.textContent = 'Install';
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.textContent = 'Not now';
  dismiss.className = 'web-notice-quiet';
  install.addEventListener('click', () => {
    void event
      .prompt()
      .then(() => event.userChoice)
      .finally(() => {
        banner.remove();
        bannerEl = null;
        deferredPrompt = null;
      });
  });
  dismiss.addEventListener('click', () => {
    markDismissed();
    banner.remove();
    bannerEl = null;
  });
  banner.append(install, dismiss);
}

/**
 * Manually re-show a deferred install prompt (e.g. from a menu action).
 * Returns false when the browser has not offered an install event yet.
 */
export function requestInstallPrompt(): boolean {
  reofferInstallPrompt();
  if (!deferredPrompt) return false;
  showInstallBanner(deferredPrompt);
  return true;
}

export function installWebChrome(): void {
  const offline = notice(
    'offline',
    'You’re offline. Centraid will reconnect to your gateway when the network returns.',
  );
  const syncOnline = (): void => {
    offline.toggleAttribute('data-visible', !navigator.onLine);
  };
  window.addEventListener('online', syncOnline);
  window.addEventListener('offline', syncOnline);
  syncOnline();

  // Keep listening across the session (not `{ once: true }`) so a later
  // re-offer after days, or a menu action, can still use the event.
  window.addEventListener('beforeinstallprompt', (raw) => {
    raw.preventDefault();
    const event = raw as InstallPromptEvent;
    deferredPrompt = event;
    if (!dismissedRecently()) showInstallBanner(event);
  });
}
