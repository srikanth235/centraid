#!/usr/bin/env node
// Fresh, standalone Electron+Playwright launcher for the REAL desktop app —
// real in-process gateway, real dev vault, no mocked HTTP. Distinct from the
// stale `apps/desktop/tests/e2e/` suite (mock-gateway harness, pre-React
// selectors) and from `apps/desktop/scripts/screenshot-*.mjs` (which route
// gateway calls to a seed server). Nothing here intercepts network traffic.
//
// Prereq: `bun run build --filter=@centraid/desktop` from the repo root (or
// `bun run build` inside apps/desktop) so `dist/main.js` + `dist/renderer/`
// exist. Re-run after any renderer/main change.
import { _electron } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DESKTOP_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Seed `<userData>/centraid-settings.json` with just enough persisted state
 * to skip first-run onboarding. Everything else — the local gateway's id,
 * URL, bearer token, and the dev vault under
 * `<userData>/gateways/local/vault/` — is created and minted by the app
 * itself on first boot (see apps/desktop/src/main/settings.ts +
 * local-gateway.ts): there is no port/URL to configure ahead of time, the
 * embedded gateway binds an ephemeral loopback port and hands the URL/token
 * to the renderer over IPC.
 *
 * Only writes the file if it doesn't already exist, so a REUSED userData dir
 * (second arg to launchApp) keeps whatever onboarding/prefs state a prior
 * launch left behind.
 */
async function ensureSettingsSeed(userDataDir) {
  const settingsPath = path.join(userDataDir, 'centraid-settings.json');
  const exists = await fs
    .access(settingsPath)
    .then(() => true)
    .catch(() => false);
  if (exists) return;
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(
    settingsPath,
    JSON.stringify(
      {
        activeGatewayId: 'local',
        onboardingCompletedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

/**
 * Launch the real desktop app.
 *
 * @param {{ userDataDir?: string, show?: boolean }} [opts]
 *   - userDataDir: reuse an existing profile dir (same gateway id 'local' ⇒
 *     same on-disk vault, so a second launch resumes state). Omit for a
 *     fresh temp dir + virgin dev vault (recreated free in v0 — see repo
 *     memory `centraid-v0-status`).
 *   - show: keep NODE_ENV off 'test' quirks that hide the window. Not needed
 *     on macOS (no headless mode either way) — present for parity with the
 *     stale suite's E2E_SHOW_WINDOW convention; unused today.
 * @returns {Promise<{ app: import('playwright').ElectronApplication, page: import('playwright').Page, userDataDir: string, close: () => Promise<void> }>}
 *   The launched Electron app/page handles, the resolved userDataDir, and a
 *   close() to tear the app down.
 */
export async function launchApp(opts = {}) {
  const userDataDir =
    opts.userDataDir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-e2e-live-')));
  await ensureSettingsSeed(userDataDir);

  const app = await _electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');

  // Readiness: the real gateway boot (mint vault, run migrations, resolve
  // settings over IPC) races the renderer's first paint. The first stable
  // signal that the shell is interactive — not just painted — is the Home
  // screen's composer heading, which only renders once App.tsx has read
  // `onboardingCompletedAt` back from getSettings() and mounted <App/>
  // instead of <OnboardingScreen/> (see src/renderer/react/boot.tsx).
  await page.getByRole('heading', { name: 'What should we build?' }).waitFor({
    state: 'visible',
    // Bumped from 45s: under heavy concurrent load on a shared dev machine
    // (multiple Electron instances from parallel sessions), first paint can
    // take well past 45s even though the app itself isn't hung.
    timeout: 120_000,
  });

  return {
    app,
    page,
    userDataDir,
    async close() {
      await app.close().catch(() => undefined);
    },
  };
}

/** Sidebar nav is a set of `<button>`s whose accessible name is the visible
 *  label (see Sidebar.tsx — icon SVGs are aria-hidden, only the label text
 *  renders). Robust to the chrome.module.css hashed class names. */
export function navTo(page, label) {
  return page.getByRole('button', { name: label, exact: true }).first().click();
}
