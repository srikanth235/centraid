#!/usr/bin/env node
// Shell QA v2 Suite 1: REAL first-run onboarding. Launches the app WITHOUT
// the driver's settings seed (no onboardingCompletedAt), so the true
// OnboardingScreen renders. Walks it as a user: disabled CTA, name entry,
// color swatch, Enter Centraid -> Home. Then relaunches with the SAME
// userDataDir and asserts onboarding does NOT show again and the profile
// name persisted.
//
// Run with: node tests/e2e-live/flows-shell-v2-01-onboarding.mjs  (from apps/desktop)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { _electron } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(__dirname, 'out', 'shell-v2');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type() });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' });
  });
}

async function step(id, label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `01-onb-${id}-FAILURE.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `01-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

/** Launch WITHOUT any settings seed — the point of this suite. */
async function launchVirgin(userDataDir) {
  await fs.mkdir(userDataDir, { recursive: true });
  const app = await _electron.launch({
    args: [DESKTOP_ROOT, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NODE_ENV: 'test' },
  });
  const p = await app.firstWindow();
  await p.waitForLoadState('domcontentloaded');
  return { app, page: p };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-e2e-onb-'));
  let app;

  try {
    // ---------- First launch: onboarding must render ----------
    const t0 = Date.now();
    ({ app, page } = await launchVirgin(userDataDir));
    wireConsole(page);
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('onb-renders', 'Virgin profile shows onboarding, not Home', async () => {
      await page
        .getByRole('heading', { name: /Make yourself/ })
        .waitFor({ state: 'visible', timeout: 120_000 });
      console.log(`[onb] onboarding painted in ${Date.now() - t0}ms`);
      const homeHeading = await page
        .getByRole('heading', { name: 'What should we build?' })
        .isVisible()
        .catch(() => false);
      assert(!homeHeading, 'Home rendered on a virgin profile — onboarding was skipped');
      await shot('01-first-run-onboarding');
    });

    await step('onb-cta-disabled-when-empty', 'CTA "Enter Centraid" is disabled while name is empty', async () => {
      const cta = page.getByRole('button', { name: 'Enter Centraid' });
      await cta.waitFor({ state: 'visible', timeout: 10_000 });
      assert(await cta.isDisabled(), 'CTA should be disabled with an empty name');
      const state = await cta.getAttribute('data-state');
      console.log(`[onb] CTA data-state with empty name: ${state}`);
    });

    await step('onb-name-and-initials', 'Typing a name updates the avatar initials live', async () => {
      const input = page.getByLabel('Your name');
      await input.fill('QA Tester');
      await page.waitForTimeout(200);
      const bodyText = await page.locator('body').innerText();
      assert(/QT/.test(bodyText), `avatar initials "QT" not found after typing "QA Tester"`);
      await shot('02-name-typed');
    });

    await step('onb-color-swatch', 'Selecting a color swatch flips aria-checked', async () => {
      const swatch = page.getByRole('radio', { name: 'Color #4FB077' });
      await swatch.click();
      await page.waitForTimeout(150);
      assert(
        (await swatch.getAttribute('aria-checked')) === 'true',
        'clicked swatch did not become aria-checked',
      );
      await shot('03-color-picked');
    });

    await step('onb-submit-lands-home', '"Enter Centraid" completes onboarding and lands on Home', async () => {
      const cta = page.getByRole('button', { name: 'Enter Centraid' });
      assert(!(await cta.isDisabled()), 'CTA still disabled with a valid name');
      await cta.click();
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 60_000 });
      await shot('04-home-after-onboarding');
      // The persisted flag must now exist on disk.
      const raw = await fs.readFile(path.join(userDataDir, 'centraid-settings.json'), 'utf8');
      const settings = JSON.parse(raw);
      console.log(`[onb] settings after onboarding: ${raw}`);
      assert(
        typeof settings.onboardingCompletedAt === 'string' && settings.onboardingCompletedAt.length > 0,
        'onboardingCompletedAt not persisted to centraid-settings.json',
      );
    });

    await step('onb-profile-name-visible', 'Chosen display name surfaces in Settings -> Spaces (gateway connection row)', async () => {
      // Observation from a prior run: the display name does NOT appear
      // anywhere in the main shell chrome (sidebar head shows the vault
      // name "Owner's vault"). The only surface that reads the profile
      // displayName back is Settings -> Spaces -> Connections (listGateways
      // threads gateway-store displayName). Verify it landed there.
      const homeText = await page.locator('body').innerText();
      console.log(`[onb] name in main shell chrome: ${/QA Tester/.test(homeText)} (expected false — recorded as UX observation)`);
      await page.getByRole('button', { name: /^Settings/ }).first().click();
      await page.getByRole('heading', { name: 'Appearance' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByRole('button', { name: 'Spaces', exact: true }).click();
      await page.getByRole('heading', { name: 'Spaces' }).first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(600);
      await shot('05-settings-spaces-after-onboarding');
      const spacesText = await page.locator('body').innerText();
      const found = /QA Tester/.test(spacesText);
      console.log(`[onb] "QA Tester" visible in Settings -> Spaces: ${found}`);
      assert(found, 'display name "QA Tester" not visible in Settings -> Spaces either — onboarding write is a dead end');
      await page.getByRole('button', { name: 'Home', exact: true }).first().click();
      await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
    });

    // ---------- Relaunch: onboarding must NOT show again ----------
    await step('onb-relaunch-skips', 'Relaunch (same profile) boots straight to Home, name intact', async () => {
      await app.close().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
      ({ app, page } = await launchVirgin(userDataDir));
      wireConsole(page);
      await page.setViewportSize({ width: 1400, height: 900 });
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 120_000 });
      const onboardingVisible = await page
        .getByRole('heading', { name: /Make yourself/ })
        .isVisible()
        .catch(() => false);
      assert(!onboardingVisible, 'onboarding rendered again after completion');
      await shot('06-relaunch-straight-to-home');
      // Name persistence check goes where the name actually surfaces:
      // Settings -> Spaces connections row.
      await page.getByRole('button', { name: /^Settings/ }).first().click();
      await page.getByRole('heading', { name: 'Appearance' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.getByRole('button', { name: 'Spaces', exact: true }).click();
      await page.waitForTimeout(600);
      const spacesText = await page.locator('body').innerText();
      assert(/QA Tester/.test(spacesText), 'display name did not persist across relaunch (Settings -> Spaces)');
      await shot('07-relaunch-spaces-name-persisted');
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ ONBOARDING VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('==========================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll onboarding steps PASSED.');
    }
  } finally {
    if (app) await app.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
