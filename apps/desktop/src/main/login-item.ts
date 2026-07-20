/*
 * Launch-at-login (issue #351, tier 4).
 *
 * With the detached gateway (#468 H1) the child can outlive the UI, but it
 * still does not survive logout/reboot unless the user opts into the OS
 * service (H5, `offerGatewayService` / `centraid-gateway service install`).
 * Launch-at-login remains the cheap 80% fix for bringing the app UI (and a
 * re-spawned detached child on next ensure) back after reboot without the
 * user remembering to open Centraid.
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
