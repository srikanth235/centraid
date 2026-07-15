#!/usr/bin/env node
// Shell QA v2 Suite 1: REAL first-run onboarding, rewritten for issue #382's
// 2-step redesign (identity -> "Where does your data live?" ConnectFlow).
// Launches the app WITHOUT the driver's settings seed (no
// onboardingCompletedAt), so the true OnboardingScreen renders. Walks it as
// a user: disabled CTA, name entry, color swatch, "Continue" into the
// embedded ConnectFlow, "This Mac" (which completes near-instantly per the
// design doc — a fresh install has 0/1 local vaults so ConnectFlow
// auto-commits without an extra click) -> Home. Then relaunches with the
// SAME userDataDir and asserts onboarding does NOT show again and the
// profile identity persisted.
//
// Empirical note (verified via a throwaway probe against the real app
// before writing this): the chosen displayName has NO visible UI surface
// anywhere in the redesigned shell — the switcher's gateway header shows
// the gateway's technical `label` ("Local"), not `displayName`; the sidebar
// head and Settings -> Space both show the VAULT's name ("Owner's vault"),
// never the person's name; Settings -> Spaces (cross-vault list + gateway
// Connections group) is deleted outright per the design doc. So the only
// verifiable ground truth for "did onboarding write the name to the right
// profile" (issue #382's actual bug fix: boot.tsx used to always write to
// 'local' even when a different gateway was the one just connected) is the
// gateway's `profile.json` on disk. This suite reads that file directly
// instead of the old (now-dead) "Settings -> Spaces -> Connections row"
// check.
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
    results.push({
      id,
      label,
      verdict: 'fail',
      ms: Date.now() - t0,
      error: err?.stack ?? String(err),
    });
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

async function readLocalProfile(userDataDir) {
  const raw = await fs.readFile(
    path.join(userDataDir, 'gateways', 'local', 'profile.json'),
    'utf8',
  );
  return JSON.parse(raw);
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
      await shot('01-first-run-onboarding-step1-identity');
    });

    await step(
      'onb-cta-disabled-when-empty',
      'Step 1 "Continue" is disabled while name is empty',
      async () => {
        const cta = page.getByRole('button', { name: 'Continue' });
        await cta.waitFor({ state: 'visible', timeout: 10_000 });
        assert(await cta.isDisabled(), 'CTA should be disabled with an empty name');
        const state = await cta.getAttribute('data-state');
        console.log(`[onb] CTA data-state with empty name: ${state}`);
      },
    );

    await step(
      'onb-name-and-initials',
      'Typing a name updates the avatar initials live',
      async () => {
        const input = page.getByLabel('Your name');
        await input.fill('QA Tester');
        await page.waitForTimeout(200);
        const bodyText = await page.locator('body').textContent();
        assert(/QT/.test(bodyText), `avatar initials "QT" not found after typing "QA Tester"`);
        await shot('02-name-typed');
      },
    );

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

    await step(
      'onb-continue-to-connect-step',
      '"Continue" advances to step 2 — "Where does your data live?" method cards',
      async () => {
        const cta = page.getByRole('button', { name: 'Continue' });
        assert(!(await cta.isDisabled()), 'CTA still disabled with a valid name');
        await cta.click();
        await page
          .getByRole('heading', { name: /Where does your data live/ })
          .waitFor({ state: 'visible', timeout: 10_000 });
        const methodGroup = page.getByRole('radiogroup', { name: 'Where does your data live?' });
        await methodGroup.waitFor({ state: 'visible', timeout: 5_000 });
        const cardText = await methodGroup.textContent();
        assert(/This Mac/.test(cardText), 'method cards missing "This Mac"');
        assert(/Existing gateway/.test(cardText), 'method cards missing "Existing gateway"');
        assert(/Over SSH/.test(cardText), 'method cards missing "Over SSH"');
        await shot('04-connect-step-method-cards');
      },
    );

    await step(
      'onb-this-mac-completes-instantly',
      '"This Mac" auto-completes onboarding (0/1 local vault) and lands on Home',
      async () => {
        await page.getByRole('radio', { name: /^This Mac/ }).click();
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 60_000 });
        await shot('05-home-after-onboarding');
        // The persisted flag must now exist on disk.
        const raw = await fs.readFile(path.join(userDataDir, 'centraid-settings.json'), 'utf8');
        const settings = JSON.parse(raw);
        console.log(`[onb] settings after onboarding: ${raw}`);
        assert(
          typeof settings.onboardingCompletedAt === 'string' &&
            settings.onboardingCompletedAt.length > 0,
          'onboardingCompletedAt not persisted to centraid-settings.json',
        );
      },
    );

    await step(
      'onb-profile-metadata-written-to-connected-gateway',
      "issue #382 bug fix: displayName/avatarColor land on the gateway ConnectFlow actually connected ('local' here), not hardcoded",
      async () => {
        // No UI surface shows displayName anywhere in the redesigned shell
        // (verified empirically — switcher header shows the gateway's
        // technical `label`, not `displayName`; Settings -> Space shows the
        // VAULT's name; the old Settings -> Spaces "Connections" list that
        // used to read this back is deleted per the design doc). The
        // profile.json on disk is the only ground truth left.
        const profile = await readLocalProfile(userDataDir);
        console.log(`[onb] gateways/local/profile.json: ${JSON.stringify(profile)}`);
        assert(
          profile.displayName === 'QA Tester',
          `expected displayName "QA Tester" on the local profile, got ${JSON.stringify(profile.displayName)}`,
        );
        assert(
          profile.avatarColor === '#4FB077',
          `expected avatarColor #4FB077 on the local profile, got ${JSON.stringify(profile.avatarColor)}`,
        );
      },
    );

    // ---------- Relaunch: onboarding must NOT show again ----------
    await step(
      'onb-relaunch-skips',
      'Relaunch (same profile) boots straight to Home, identity intact on disk',
      async () => {
        await app.close().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 500));
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
        const profile = await readLocalProfile(userDataDir);
        assert(
          profile.displayName === 'QA Tester',
          `displayName did not persist across relaunch, got ${JSON.stringify(profile.displayName)}`,
        );
      },
    );

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
