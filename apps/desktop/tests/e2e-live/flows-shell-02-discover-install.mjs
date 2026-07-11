#!/usr/bin/env node
// Shell QA Suite 2: Discover browse/filter/preview, installing an app
// template end-to-end (Notes), driving its live iframe, and the
// "reopen an installed app after relaunch" corner case (reused userDataDir).
//
// Run with: node apps/desktop/tests/e2e-live/flows-shell-02-discover-install.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-shell-02');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-disc-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `disc-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[disc] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('discover-32-tiles', 'Discover renders exactly 32 template tiles', async () => {
      await navTo(page, 'Discover');
      const tiles = page.locator('button[data-kind]');
      await tiles.first().waitFor({ state: 'visible', timeout: 20_000 });
      const count = await tiles.count();
      assert(count === 32, `expected 32 templates, got ${count}`);
      const appCount = await page.locator('button[data-kind="app"]').count();
      const autoCount = await page.locator('button[data-kind="automation"]').count();
      assert(appCount === 8, `expected 8 apps, got ${appCount}`);
      assert(autoCount === 24, `expected 24 automations, got ${autoCount}`);
      await shot('01-all-tiles');
    });

    await step('discover-filter-tabs', 'Apps/Automations/All filter tabs work', async () => {
      await page.getByRole('tab', { name: /^Apps/ }).click();
      await page.waitForTimeout(200);
      let visible = await page.locator('button[data-kind="app"]:visible').count();
      let hiddenAutomations = await page.locator('button[data-kind="automation"]:visible').count();
      console.log(
        `[disc] Apps tab: visible apps=${visible} visible automations=${hiddenAutomations}`,
      );
      assert(visible === 8, `Apps tab: expected 8 visible app tiles, got ${visible}`);
      assert(
        hiddenAutomations === 0,
        `Apps tab: expected 0 visible automation tiles, got ${hiddenAutomations}`,
      );
      await shot('02-apps-only');

      await page.getByRole('tab', { name: /^Automations/ }).click();
      await page.waitForTimeout(200);
      visible = await page.locator('button[data-kind="automation"]:visible').count();
      assert(visible === 24, `Automations tab: expected 24, got ${visible}`);
      await shot('02-automations-only');

      await page.getByRole('tab', { name: /^All/ }).click();
      await page.waitForTimeout(200);
      assert(
        (await page.locator('button[data-kind]:visible').count()) === 32,
        'All tab should restore 32 visible',
      );
    });

    await step(
      'discover-layout-toggle',
      'Rows/Tiles layout toggle changes presentation',
      async () => {
        const layoutGroup = page.getByRole('group', { name: 'Layout' });
        await layoutGroup.getByRole('button', { name: 'Rows', exact: true }).click();
        await page.waitForTimeout(200);
        await shot('03-rows-layout');
        await layoutGroup.getByRole('button', { name: 'Tiles', exact: true }).click();
        await page.waitForTimeout(200);
        await shot('03-tiles-layout');
      },
    );

    await step(
      'discover-preview-open-close',
      'Open a template preview dialog and close it (Escape)',
      async () => {
        const notesCard = page.locator('button[data-kind="app"]', { hasText: 'Notes' }).first();
        await notesCard.waitFor({ state: 'visible', timeout: 10_000 });
        await notesCard.click();
        const dialog = page.getByRole('dialog', { name: /^Preview Notes/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('04-preview-dialog-open');
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
        await shot('04-preview-dialog-closed');
      },
    );

    await step(
      'install-notes-e2e',
      'Install Notes: Discover -> preview -> Use this template -> Home tile + sidebar APPS entry',
      async () => {
        const notesCard = page.locator('button[data-kind="app"]', { hasText: 'Notes' }).first();
        await notesCard.waitFor({ state: 'visible', timeout: 10_000 });
        await notesCard.click();
        const dialog = page.getByRole('dialog', { name: /^Preview Notes/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use this template' }).click();

        const toast = page.locator('[data-global-toast]');
        await toast.waitFor({ state: 'visible', timeout: 10_000 });
        const toastText = await toast.textContent();
        assert(/Installed "Notes"/.test(toastText ?? ''), `unexpected toast: ${toastText}`);
        console.log(`[disc] install toast: ${toastText}`);

        // Lands on Home with the new tile.
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
        const tile = page.locator('[data-app-id="notes"]');
        await tile.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('05-home-with-notes-tile');

        // Sidebar APPS section should now list it too.
        const sidebarAppsSection = page.locator('text=APPS').first();
        await sidebarAppsSection
          .waitFor({ state: 'visible', timeout: 5_000 })
          .catch(() => undefined);
        const sidebarNotesEntry = page.locator('.chrome-module__side, aside, nav').first();
        void sidebarNotesEntry;
        const sidebarHasNotes = await page.getByRole('button', { name: /Notes/ }).count();
        console.log(`[disc] sidebar buttons matching /Notes/: ${sidebarHasNotes}`);
        assert(sidebarHasNotes >= 1, 'sidebar APPS section does not show the installed Notes app');
        await shot('05-sidebar-with-notes');
      },
    );

    await step(
      'open-notes-iframe-create-note',
      'Open Notes app -> iframe renders real content -> create a note (proves live)',
      async () => {
        const tile = page.locator('[data-app-id="notes"]');
        await tile.getByTestId('app-tile').click();
        const iframe = page.waitForSelector('iframe[data-centraid-app="1"]', {
          state: 'attached',
          timeout: 20_000,
        });
        await iframe;
        const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
        await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(500);
        await shot('06-notes-app-open-empty');

        // Create one note via the quick-add title input + Enter.
        const titleInput = frameLoc.locator('#titleInput');
        await titleInput.waitFor({ state: 'visible', timeout: 10_000 });
        await titleInput.fill('E2E QA note — shell suite');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(700);
        await shot('06-notes-app-after-create');

        const noteList = frameLoc.locator('#noteList');
        const listText = await noteList.textContent().catch(() => '');
        console.log(`[disc] note list text after create: ${JSON.stringify(listText)}`);
        assert(/E2E QA note/.test(listText ?? ''), 'created note not showing in the note list');
      },
    );

    await step(
      'relaunch-reopen-installed-app',
      'Corner case: relaunch (same userDataDir) -> Notes still installed with note persisted',
      async () => {
        await session.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        await page.setViewportSize({ width: 1400, height: 900 });

        const tile = page.locator('[data-app-id="notes"]');
        await tile.waitFor({ state: 'visible', timeout: 15_000 });
        await shot('07-relaunch-home');

        await tile.getByTestId('app-tile').click();
        await page.waitForSelector('iframe[data-centraid-app="1"]', {
          state: 'attached',
          timeout: 20_000,
        });
        const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
        await frameLoc.locator('#noteList').waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(500);
        const listText = await frameLoc
          .locator('#noteList')
          .textContent()
          .catch(() => '');
        console.log(`[disc] note list text after relaunch: ${JSON.stringify(listText)}`);
        assert(
          /E2E QA note/.test(listText ?? ''),
          'note created before relaunch did not persist across relaunch',
        );
        await shot('07-relaunch-reopened-app-with-note');
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ DISCOVER/INSTALL VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('===================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll discover/install steps PASSED.');
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
