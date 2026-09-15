/*
 * Test-only Electron main entry (#1020 wave 3 lane F).
 *
 * Playwright launches this instead of the production app so that every
 * e2e-specific main-process concern lives here and `src/main.ts` carries no
 * test, CI or platform branches. That split is v0's and the reason is the same
 * (census §F9): a production entry with a CI branch is a production entry
 * nobody can reason about.
 *
 * Two things it does, both carried from v0's own entry:
 *
 * 1. `appendSwitch("password-store", ...)` BEFORE ready. On a headless Linux
 *    runner Chromium's OSCrypt picks the keyless `basic` backend and
 *    `safeStorage.isEncryptionAvailable()` stays false; the switch is the only
 *    reliable way to select a real backend, and Electron ignores it if it
 *    arrives after `ready`. `basic` is chosen here rather than
 *    `gnome-libsecret`: this container has no keyring daemon to unlock, and the
 *    seat's own secrets live in the vault's keystore rather than in
 *    safeStorage, so the backend only has to be deterministic.
 * 2. Hides the window locally so a dev's run does not steal focus. A hidden
 *    window is throttled ~5x by Chromium, so background throttling is turned
 *    off with it — otherwise the suite crawls.
 */
import { app } from "electron";

app.commandLine.appendSwitch("password-store", "basic");

if (process.env.E2E_SHOW_WINDOW !== "1") {
  app.on("browser-window-created", (_event, win) => {
    win.webContents.setBackgroundThrottling(false);
    win.once("ready-to-show", () => win.hide());
    win.hide();
  });
}

// Hand off to the real, unmodified app entry.
await import("../electron/dist/main.js");
