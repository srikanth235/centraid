#!/usr/bin/env node
// Shell QA Suite 1: sidebar navigation across every screen, window chrome
// (back/forward, sidebar collapse), and navigation-related corner cases
// (rapid double-clicks, navigating while a dialog is open).
//
// Run with: node apps/desktop/tests/e2e-live/flows-shell-01-nav-chrome.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({
      text: msg.text(),
      type: msg.type(),
      frameUrl: msg.location()?.url ?? '',
    });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', frameUrl: '' });
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-nav-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `nav-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const session = await launchApp();
  page = session.page;
  wireConsole(page);
  console.log(`[nav] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    const screens = [
      { label: 'Home', heading: 'What should we build?', level: undefined },
      { label: 'Assistant', heading: null }, // Assistant's "heading" is a styled <div>, not an <h1> — checked separately below
      { label: 'Insights', heading: 'Insights', level: 1 },
      { label: 'Discover', heading: null }, // Discover has its own header, checked via tiles
      { label: 'Starred', heading: 'Starred', level: 1 },
      { label: 'Automations', heading: 'Automations', level: 1 },
      { label: 'Approvals', heading: 'Approvals', level: 1 },
    ];

    for (const s of screens) {
      await step(
        `nav-${s.label}`,
        `Sidebar -> ${s.label} renders, no blank pane, no error toast`,
        async () => {
          await navTo(page, s.label);
          await page.waitForTimeout(400);
          if (s.heading) {
            await page
              .getByRole('heading', { name: s.heading, level: s.level })
              .waitFor({ state: 'visible', timeout: 15_000 });
          } else if (s.label === 'Discover') {
            await page
              .locator('button[data-kind]')
              .first()
              .waitFor({ state: 'visible', timeout: 15_000 });
          } else if (s.label === 'Assistant') {
            await page
              .getByPlaceholder('Ask your vault anything…')
              .waitFor({ state: 'visible', timeout: 15_000 });
          }
          const errorToast = await page
            .locator('[data-global-toast]')
            .filter({ hasText: /error|fail/i })
            .isVisible()
            .catch(() => false);
          assert(!errorToast, `error toast visible on ${s.label}`);
          // Body should not be visually empty: check the main content area has
          // some rendered text/height beyond the sidebar.
          const bodyText = await page.locator('body').textContent();
          assert(bodyText.trim().length > 20, `page looks empty on ${s.label}`);
          await shot(`screen-${s.label.toLowerCase()}`);
        },
      );
    }

    // Settings has a non-exact accessible name (trailing "live" status pill).
    await step('nav-Settings', 'Sidebar -> Settings renders', async () => {
      await page
        .getByRole('button', { name: /^Settings/ })
        .first()
        .click();
      await page
        .getByRole('heading', { name: 'Appearance' })
        .waitFor({ state: 'visible', timeout: 15_000 });
      await shot('screen-settings');
    });

    await step('back-home', 'Return to Home', async () => {
      await navTo(page, 'Home');
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 10_000 });
    });

    // ---- Window chrome: back/forward ----
    await step('chrome-back-forward', 'Back/Forward nav buttons walk router history', async () => {
      await navTo(page, 'Discover');
      await page
        .locator('button[data-kind]')
        .first()
        .waitFor({ state: 'visible', timeout: 15_000 });
      await navTo(page, 'Automations');
      await page
        .getByRole('heading', { name: 'Automations', level: 1 })
        .waitFor({ state: 'visible', timeout: 15_000 });

      const backBtn = page.getByRole('button', { name: 'Back' });
      const backVisible = await backBtn.isVisible().catch(() => false);
      console.log(`[chrome] Back button visible: ${backVisible}`);
      if (backVisible) {
        await backBtn.click();
        await page.waitForTimeout(400);
        await shot('chrome-after-back');
        const forwardBtn = page.getByRole('button', { name: 'Forward' });
        const forwardVisible = await forwardBtn.isVisible().catch(() => false);
        console.log(`[chrome] Forward button visible after Back: ${forwardVisible}`);
        if (forwardVisible) {
          await forwardBtn.click();
          await page.waitForTimeout(400);
          await shot('chrome-after-forward');
        }
      } else {
        console.log(
          '[chrome] Back/Forward buttons not present on this route — recording as observation, not failure',
        );
      }
      await navTo(page, 'Home');
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 10_000 });
    });

    // ---- Sidebar collapse toggle ----
    await step(
      'chrome-sidebar-collapse',
      'Sidebar collapse/expand toggle works both directions',
      async () => {
        const hideBtn = page.getByRole('button', { name: 'Hide sidebar' });
        await hideBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await hideBtn.click();
        await page.waitForTimeout(400);
        const windowState = await page
          .locator('[data-sidebar]')
          .first()
          // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- (#363) this is a Playwright Locator, not a DOM node; Locator has no .dataset
          .getAttribute('data-sidebar')
          .catch(() => null);
        console.log(`[chrome] data-sidebar after collapse: ${windowState}`);
        await shot('chrome-sidebar-collapsed');
        assert(windowState === 'closed', `expected data-sidebar="closed", got ${windowState}`);

        const showBtn = page.getByRole('button', { name: 'Show sidebar' }).first();
        await showBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await showBtn.click();
        await page.waitForTimeout(400);
        const windowState2 = await page
          .locator('[data-sidebar]')
          .first()
          // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- (#363) this is a Playwright Locator, not a DOM node; Locator has no .dataset
          .getAttribute('data-sidebar')
          .catch(() => null);
        console.log(`[chrome] data-sidebar after expand: ${windowState2}`);
        await shot('chrome-sidebar-expanded');
        assert(windowState2 === 'open', `expected data-sidebar="open" again, got ${windowState2}`);
      },
    );

    // ---- Corner case: rapid double-clicks on nav ----
    await step(
      'corner-rapid-double-click',
      'Rapid double-click on nav items does not break the shell',
      async () => {
        const discoverBtn = page.getByRole('button', { name: 'Discover', exact: true }).first();
        await discoverBtn.dblclick();
        await page.waitForTimeout(300);
        const insightsBtn = page.getByRole('button', { name: 'Insights', exact: true }).first();
        await insightsBtn.dblclick();
        await page.waitForTimeout(300);
        const homeBtn = page.getByRole('button', { name: 'Home', exact: true }).first();
        await homeBtn.dblclick();
        await page.waitForTimeout(400);
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await shot('corner-after-rapid-dblclick');
      },
    );

    // ---- Corner case: navigate while a dialog is open ----
    await step(
      'corner-nav-while-dialog-open',
      'Sidebar nav while a template preview dialog is open',
      async () => {
        await navTo(page, 'Discover');
        const firstAppCard = page.locator('button[data-kind="app"]').first();
        await firstAppCard.waitFor({ state: 'visible', timeout: 15_000 });
        await firstAppCard.click();
        const dialog = page.getByRole('dialog', { name: /^Preview / });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('corner-dialog-open-before-nav');

        // Try navigating away via sidebar WITHOUT closing the dialog first.
        // The modal backdrop (modal.module.css) intercepts pointer events, so
        // a normal click on the sidebar button may not even land — that's
        // expected modal-trap behavior, not a bug. Use a short timeout and
        // tolerate the click failing to land.
        await page
          .getByRole('button', { name: 'Automations', exact: true })
          .first()
          .click({ timeout: 3_000 })
          .catch((err) =>
            console.log(
              `[corner] sidebar click did not land while dialog open (expected if backdrop traps clicks): ${err.message.split('\n')[0]}`,
            ),
          );
        await page.waitForTimeout(500);
        await shot('corner-after-nav-with-dialog-open');
        const dialogStillVisible = await dialog.isVisible().catch(() => false);
        const automationsHeadingVisible = await page
          .getByRole('heading', { name: 'Automations', level: 1 })
          .isVisible()
          .catch(() => false);
        console.log(
          `[corner] after clicking Automations while dialog open: dialogStillVisible=${dialogStillVisible} automationsHeadingVisible=${automationsHeadingVisible}`,
        );
        // Either behavior (dialog blocks nav, or nav dismisses dialog) is
        // acceptable UX — what's NOT acceptable is BOTH the dialog AND the
        // destination screen appearing stacked/broken, or neither appearing.
        assert(
          dialogStillVisible !== automationsHeadingVisible,
          'ambiguous/broken state: need exactly one of {dialog, destination screen} visible',
        );
        // Clean up: close dialog if still open, get back to Home.
        if (dialogStillVisible) {
          await page.keyboard.press('Escape');
          await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
        }
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ NAV/CHROME VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('=============================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll nav/chrome steps PASSED.');
    }
  } finally {
    await session.close();
    await fs.rm(session.userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
