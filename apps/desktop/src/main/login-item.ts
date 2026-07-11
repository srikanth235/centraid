/*
 * Launch-at-login (issue #351, tier 4).
 *
 * Centraid's gateway is desktop-hosted and deliberately has no OS scheduler
 * keeping it alive independent of the app (see gateway-supervisor-core.ts's
 * doc comment) — quitting the app really does take the gateway down.
 * Launch-at-login is the cheap 80% fix: it can't survive a running app being
 * force-quit, but it does mean a reboot or a fresh login brings Centraid (and
 * its embedded gateway) back up without the user remembering to open it.
 *
 * This just wraps `app.setLoginItemSettings` — thin enough that it doesn't
 * need a `-core.ts` split, but pulled out of settings.ts/main.ts so both the
 * startup call site and the settings-IPC call site share one implementation
 * rather than duplicating the platform guard.
 */

import { app } from 'electron';

/**
 * Apply the `launchAtLogin` preference to the OS. A no-op on Linux — Electron
 * doesn't implement `setLoginItemSettings` there (autostart is desktop-file
 * based and varies by distro/DE), so calling it would silently do nothing;
 * skipping it explicitly keeps that a documented gap instead of a mystery.
 */
export function applyLaunchAtLogin(enabled: boolean | undefined): void {
  if (process.platform === 'linux') return;
  app.setLoginItemSettings({ openAtLogin: enabled === true });
}
