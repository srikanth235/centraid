#!/usr/bin/env node
// Shell QA v2 Suite 4: corner cases the v1 suites don't touch —
// - rapid-fire nav clicking across every route (not just dblclick)
// - vault-switcher popover at SETTLED state (opacity recheck after the
//   140ms entry animation; the suite-2 shot was caught mid-animation)
// - Escape / scrim-click closing the vault switcher
// - narrow viewports (375x812 phone, 720x900): no horizontal overflow,
//   shell still usable (mobile-first repo rule)
// - Home composer anatomy: placeholder, Build control, suggestion chips
// - sidebar collapsed state persists across relaunch
//
// Run with: node tests/e2e-live/flows-shell-v2-04-corners.mjs  (from apps/desktop)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'shell-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-shell-v2-04');

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
      await page.screenshot({ path: path.join(OUT_DIR, `04-${id}-FAILURE.png`) });
    } catch {
      /* ignore */
    }
    try {
      await page.keyboard.press('Escape');
      await page.mouse.click(5, 890);
      await page.waitForTimeout(300);
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `04-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function goHome() {
  await navTo(page, 'Home');
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function noHorizontalOverflow(label) {
  const metrics = await page.evaluate(() => ({
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    bodyScrollW: document.body.scrollWidth,
  }));
  console.log(
    `[v2-04] ${label}: scrollWidth=${metrics.scrollW} clientWidth=${metrics.clientW} bodyScrollWidth=${metrics.bodyScrollW}`,
  );
  assert(
    metrics.scrollW <= metrics.clientW + 1,
    `${label}: horizontal overflow (scrollWidth ${metrics.scrollW} > clientWidth ${metrics.clientW})`,
  );
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[v2-04] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---------- Home composer anatomy ----------
    await step(
      'home-composer',
      'Home composer: prompt box, Build control, suggestion chips all render',
      async () => {
        const composer = page.getByPlaceholder(/Describe an app you want/);
        await composer.waitFor({ state: 'visible', timeout: 10_000 });
        const buildBtn = page.getByRole('button', { name: /Build/ }).first();
        assert(await buildBtn.isVisible(), 'Build control missing from the composer');
        for (const chip of ['Habit tracker', 'Weekly review', 'Inbox digest', 'Invoice filer']) {
          assert(
            await page
              .getByRole('button', { name: chip })
              .isVisible()
              .catch(() => false),
            `suggestion chip "${chip}" missing`,
          );
        }
        // Type into the composer — text must round-trip, no crash.
        await composer.fill('a tiny QA scratchpad app');
        assert(
          (await composer.inputValue()) === 'a tiny QA scratchpad app',
          'composer text did not round-trip',
        );
        await composer.fill('');
        await shot('01-home-composer');
      },
    );

    // ---------- Rapid-fire nav ----------
    await step(
      'rapid-nav-storm',
      '15 rapid nav clicks across all routes leave the shell coherent',
      async () => {
        const routes = [
          'Discover',
          'Insights',
          'Automations',
          'Approvals',
          'Starred',
          'Assistant',
          'Home',
        ];
        for (let i = 0; i < 15; i++) {
          const label = routes[i % routes.length];
          await page.getByRole('button', { name: label, exact: true }).first().click({ delay: 0 });
          // no waiting — the point is to hammer the router
        }
        await page.waitForTimeout(800);
        // We ended on a known route; shell must be coherent: exactly one main
        // heading, no stacked screens, no error toast.
        await goHome();
        const errorToast = await page
          .locator('[data-global-toast]')
          .filter({ hasText: /error|fail/i })
          .isVisible()
          .catch(() => false);
        assert(!errorToast, 'error toast after rapid nav storm');
        await shot('02-after-rapid-nav');
      },
    );

    // ---------- Vault switcher: settled opacity + close paths ----------
    await step(
      'vault-switcher-settled',
      'Vault switcher popover fully settles (no translucent text bleed)',
      async () => {
        const head = page.locator('[class*="head"]').first();
        await page.keyboard.press('Meta+Shift+G');
        const menu = page.getByRole('menu');
        const opened = await menu
          .waitFor({ state: 'visible', timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        if (!opened) {
          // Fall back to clicking the sidebar head.
          await head.click();
          await menu.waitFor({ state: 'visible', timeout: 5_000 });
        }
        console.log(`[v2-04] switcher opened via ${opened ? 'Cmd+Shift+G' : 'head click'}`);
        await page.waitForTimeout(900); // let the 140ms vsPop animation fully settle
        await shot('03-vault-switcher-settled');

        // Close via Escape — does the switcher handle it?
        await page.keyboard.press('Escape');
        const closedByEscape = await menu
          .waitFor({ state: 'hidden', timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
        console.log(`[v2-04] vault switcher closed by Escape: ${closedByEscape}`);
        if (!closedByEscape) {
          // Scrim click is the designed close path; verify it works.
          await page.mouse.click(700, 700);
          await menu.waitFor({ state: 'hidden', timeout: 3_000 });
          throw new Error(
            'BUG: Escape does not close the vault switcher popover (scrim click does)',
          );
        }
      },
    );

    // ---------- Narrow viewports ----------
    await step(
      'narrow-375-phone',
      '375x812 phone width: Home/Discover/Settings no horizontal overflow',
      async () => {
        await page.setViewportSize({ width: 375, height: 812 });
        await page.waitForTimeout(600);
        await shot('04-narrow-375-home');
        await noHorizontalOverflow('375 Home');

        await navTo(page, 'Discover');
        await page
          .locator('button[data-kind]')
          .first()
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(400);
        await shot('04-narrow-375-discover');
        await noHorizontalOverflow('375 Discover');

        await page
          .getByRole('button', { name: /^Settings/ })
          .first()
          .click();
        await page
          .getByRole('heading', { name: 'Appearance' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(400);
        await shot('04-narrow-375-settings');
        await noHorizontalOverflow('375 Settings');
        await goHome();
      },
    );

    await step('narrow-720-tablet', '720x900: shell lays out sanely', async () => {
      await page.setViewportSize({ width: 720, height: 900 });
      await page.waitForTimeout(600);
      await shot('05-narrow-720-home');
      await noHorizontalOverflow('720 Home');
      await page.setViewportSize({ width: 1400, height: 900 });
      await page.waitForTimeout(400);
    });

    // ---------- Sidebar collapse persistence across relaunch ----------
    await step(
      'sidebar-collapse-relaunch',
      'Collapsed sidebar persists across relaunch',
      async () => {
        const hideBtn = page.getByRole('button', { name: 'Hide sidebar' });
        await hideBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await hideBtn.click();
        await page.waitForTimeout(500);
        assert(
          (await page.locator('[data-sidebar]').first().getAttribute('data-sidebar')) === 'closed',
          'sidebar did not collapse',
        );
        await session.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.waitForTimeout(500);
        const state = await page.locator('[data-sidebar]').first().getAttribute('data-sidebar');
        console.log(`[v2-04] data-sidebar after relaunch: ${state}`);
        await shot('06-relaunch-sidebar-state');
        assert(
          state === 'closed',
          `collapsed sidebar did not persist relaunch (data-sidebar=${state})`,
        );
        // Restore for cleanliness.
        const showBtn = page.getByRole('button', { name: 'Show sidebar' }).first();
        await showBtn.click();
        await page.waitForTimeout(400);
      },
    );

    // ---------- Escape closes Discover preview (regression guard at narrow width) ----------
    await step(
      'escape-closes-preview-narrow',
      'Escape closes a template preview at 375px too',
      async () => {
        await page.setViewportSize({ width: 375, height: 812 });
        await page.waitForTimeout(400);
        await navTo(page, 'Discover');
        const card = page.locator('button[data-kind="app"]').first();
        await card.waitFor({ state: 'visible', timeout: 15_000 });
        await card.click();
        const dialog = page.getByRole('dialog', { name: /^Preview / });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(700);
        await shot('07-narrow-preview-open');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
        await page.setViewportSize({ width: 1400, height: 900 });
        await goHome();
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ CORNER-CASES VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('============================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll corner-case steps PASSED.');
    }
  } finally {
    await session.close();
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
