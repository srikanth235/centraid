// Test-only Electron main entry. Playwright launches this instead of the
// production app so that all e2e-specific main-process setup lives here, keeping
// production main.ts free of any test/CI/platform branches.
//
// Why this file exists: on a headless Linux CI runner the desktop environment
// is unrecognised, so Chromium's OSCrypt auto-selects the keyless `basic`
// backend and safeStorage.isEncryptionAvailable() stays false. The only
// reliable way to select the real `gnome-libsecret` backend (the keyring the
// CI step unlocks) is app.commandLine.appendSwitch BEFORE `ready` — Electron
// ignores --password-store passed via argv, and XDG_CURRENT_DESKTOP detection
// is unreliable in Electron 37. The switch is a no-op on macOS/Windows, which
// use the native Keychain/DPAPI, so it needs no platform guard.
import { app } from 'electron';

app.commandLine.appendSwitch('password-store', 'gnome-libsecret');

// "Headless" for local runs without touching main.ts. Electron has no real
// headless mode, but on a dev's Mac we don't want the window stealing focus.
// main.ts constructs the BrowserWindow with the default show:true, so instead
// of changing that we reach the window from here, the moment it's created, and
// hide it. A hidden window is throttled ~5x by Chromium, so we also disable
// background throttling or the suite crawls. Both are runtime APIs on the
// window object, so production main.ts stays pristine.
//
// CI is deliberately excluded: there the window already lives invisibly in
// xvfb's virtual display and stays *shown* (un-throttled) — the exact path the
// nightly run is green on. Hiding it there would re-enter the throttling that
// caused the earlier 6-minute slowdown, so we leave CI alone. Locally, opt out
// with E2E_SHOW_WINDOW=1 to watch a run.
if (!process.env.CI && process.env.E2E_SHOW_WINDOW !== '1') {
  app.on('browser-window-created', (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.once('ready-to-show', () => win.hide());
    win.hide();
  });
}

// Hand off to the real, unmodified app entry.
await import('../../dist/main.js');
