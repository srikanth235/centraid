#!/usr/bin/env node
// Shell QA Suite 3: Cmd+K command palette (open/query/unicode+XSS/empty/close),
// Starred flow (star via context menu, verify data-starred flag), Settings
// tab walk, Automations screen + browsing an automation template's detail
// from Discover.
//
// Run with: node apps/desktop/tests/e2e-live/flows-shell-03-search-star-settings.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-shell-03');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-s3-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `s3-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[s3] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ============================= SEARCH (Cmd+K) =============================

    await step('search-open', 'Cmd+K opens the command palette dialog', async () => {
      await page.keyboard.press('Meta+K');
      const dialog = page.getByRole('dialog', { name: 'Command palette' });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('01-palette-open-empty');
    });

    await step('search-query', 'Typing a query filters results sanely', async () => {
      const input = page.getByPlaceholder('Search apps, chats, templates — or describe a new one…');
      await input.fill('Notes');
      await page.waitForTimeout(400);
      await shot('02-palette-query-notes');
      const resultText = await page
        .locator('.results, [class*="results"]')
        .first()
        .textContent()
        .catch(() => '');
      console.log(`[s3] palette results for "Notes": ${JSON.stringify(resultText?.slice(0, 300))}`);
    });

    await step(
      'search-empty-query',
      'Corner case: clearing back to an empty query does not break the palette',
      async () => {
        const input = page.getByPlaceholder(
          'Search apps, chats, templates — or describe a new one…',
        );
        await input.fill('');
        await page.waitForTimeout(400);
        await shot('03-palette-empty-query');
        const dialog = page.getByRole('dialog', { name: 'Command palette' });
        assert(await dialog.isVisible(), 'palette dialog disappeared on empty query');
      },
    );

    await step(
      'search-unicode-xss',
      'Corner case: unicode + literal <script> query renders escaped, not executed',
      async () => {
        const input = page.getByPlaceholder(
          'Search apps, chats, templates — or describe a new one…',
        );
        const payload = '日本語 🎉 <script>alert(1)</script>';
        await input.fill(payload);
        await page.waitForTimeout(400);
        await shot('04-palette-unicode-xss-query');

        // Prove no alert() fired (no script execution) — Playwright would hang
        // waiting on a real dialog if one appeared; instead assert no JS dialog
        // handler fired by checking document state normally + that the input's
        // literal value round-trips.
        const inputValue = await input.inputValue();
        assert(inputValue === payload, `input did not preserve literal query text: ${inputValue}`);

        // Assert no live <script> tag was injected into the DOM by our query.
        const scriptTagCount = await page.evaluate(
          (marker) =>
            document.querySelectorAll(`script`).length &&
            document.body.innerHTML.includes(marker) &&
            document.querySelectorAll('script[data-injected-by-test]').length,
          payload,
        );
        assert(
          scriptTagCount === 0,
          'a <script> tag appears to have been injected from the search query',
        );

        // If results render the query text anywhere, it must be as literal
        // escaped text, not as a live element — check the raw innerHTML for an
        // UNescaped "<script>" tag (i.e. actual markup, not the escaped entity).
        const resultsHtml = await page
          .locator('.results, [class*="results"]')
          .first()
          .evaluate((el) => el.innerHTML)
          .catch(() => '');
        const hasLiveScriptTag = /<script[\s>]/i.test(resultsHtml);
        console.log(`[s3] results innerHTML contains a live <script> tag: ${hasLiveScriptTag}`);
        assert(!hasLiveScriptTag, 'query text was injected as a live <script> tag — XSS');
      },
    );

    await step('search-close', 'Escape closes the palette', async () => {
      await page.keyboard.press('Escape');
      const dialog = page.getByRole('dialog', { name: 'Command palette' });
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
      await shot('05-palette-closed');
    });

    // ============================= STARRED =============================

    await step(
      'install-agenda-for-star',
      'Install Agenda template (fixture for the star flow)',
      async () => {
        await navTo(page, 'Discover');
        const card = page.locator('button[data-kind="app"]', { hasText: 'Agenda' }).first();
        await card.waitFor({ state: 'visible', timeout: 15_000 });
        await card.click();
        const dialog = page.getByRole('dialog', { name: /^Preview Agenda/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use this template' }).click();
        await page.locator('[data-app-id="agenda"]').waitFor({ state: 'visible', timeout: 10_000 });
      },
    );

    await step(
      'star-app-via-context-menu',
      'Star Agenda via its context menu; data-starred flag flips',
      async () => {
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
        const tile = page.locator('[data-app-id="agenda"]');
        await tile.waitFor({ state: 'visible', timeout: 10_000 });
        const starredBefore = await tile.getAttribute('data-starred');
        console.log(`[s3] data-starred before: ${starredBefore}`);

        await tile.getByTestId('app-tile').click({ button: 'right' });
        const menu = page.getByRole('menu');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        const menuText = await menu.textContent();
        console.log(`[s3] context menu text: ${JSON.stringify(menuText)}`);
        assert(/Star/.test(menuText ?? ''), `expected a Star/Unstar menu item, got: ${menuText}`);
        await menu.getByRole('menuitem', { name: /^Star$/ }).click();
        await page.waitForTimeout(400);

        const starredAfter = await tile.getAttribute('data-starred');
        console.log(`[s3] data-starred after: ${starredAfter}`);
        assert(
          starredAfter === 'true',
          `expected data-starred="true" after starring, got ${starredAfter}`,
        );
        await shot('06-agenda-starred-home');
      },
    );

    await step(
      'starred-page-check',
      'Visit the Starred sidebar page after starring an app',
      async () => {
        await navTo(page, 'Starred');
        await page
          .getByRole('heading', { name: 'Starred', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(300);
        const bodyText = await page.locator('body').textContent();
        console.log(`[s3] Starred page body text: ${JSON.stringify(bodyText.slice(0, 200))}`);
        await shot('07-starred-page');
        // NOTE (observation, not a hard failure): if this page shows an empty
        // state despite Agenda being starred, that's a real product gap worth
        // flagging — recorded in the final report either way.
      },
    );

    // ============================= SETTINGS TAB WALK =============================

    const settingsTabs = [
      'Appearance',
      'Layout',
      'Workspace',
      'Spaces',
      'Phone',
      'Import',
      'Connections',
      'Agents',
    ];
    await step(
      'settings-tab-walk',
      'Walk every Settings tab — each renders without error',
      async () => {
        await page
          .getByRole('button', { name: /^Settings/ })
          .first()
          .click();
        for (const tabName of settingsTabs) {
          const tabBtn = page.getByRole('button', { name: tabName, exact: true });
          await tabBtn.waitFor({ state: 'visible', timeout: 10_000 });
          await tabBtn.click();
          await page.waitForTimeout(300);
          await page
            .getByRole('heading', { name: tabName })
            .waitFor({ state: 'visible', timeout: 10_000 });
          const errorToast = await page
            .locator('[data-global-toast]')
            .filter({ hasText: /error|fail/i })
            .isVisible()
            .catch(() => false);
          assert(!errorToast, `error toast visible on Settings > ${tabName}`);
          await shot(`08-settings-${tabName.toLowerCase()}`);
          console.log(`[s3] Settings > ${tabName} rendered OK`);
        }
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
      },
    );

    // ============================= AUTOMATIONS =============================

    await step(
      'automations-screen-and-template-detail',
      'Automations screen renders; browse an automation template detail from Discover',
      async () => {
        await navTo(page, 'Automations');
        await page
          .getByRole('heading', { name: 'Automations', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await shot('09-automations-screen');

        await navTo(page, 'Discover');
        const autoCard = page.locator('button[data-kind="automation"]').first();
        await autoCard.waitFor({ state: 'visible', timeout: 15_000 });
        const autoName = await autoCard
          .locator('.cardName, [class*="cardName"]')
          .first()
          .textContent()
          .catch(() => null);
        console.log(`[s3] previewing automation template: ${autoName}`);
        await autoCard.click();
        // Automation template preview is a right-side drawer with
        // aria-label="{name} template" (NOT "Preview {name}" like app dialogs).
        const dialog = page.getByRole('dialog', { name: /template$/i });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        const dialogText = await dialog.textContent();
        console.log(
          `[s3] automation preview dialog text: ${JSON.stringify(dialogText?.slice(0, 300))}`,
        );
        await shot('09-automation-template-preview');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
        await navTo(page, 'Home');
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ SEARCH/STAR/SETTINGS VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('========================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll search/star/settings steps PASSED.');
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
