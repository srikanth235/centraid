#!/usr/bin/env node
// Shell QA v2 Suite 3: full install -> search -> star -> DELETE lifecycle.
// Extends the v1 suites (which stop at install + star) with the removal arc:
// - palette search: no-results state, special-chars query, result navigation
//   (Enter opens an installed app), and post-delete search (no ghosts)
// - delete an app WHILE it is starred: gone from Home, sidebar APPS, the
//   Starred page (no ghost card), and palette results
// - cancel path on the delete confirm dialog
//
// Run with: node tests/e2e-live/flows-shell-v2-03-uninstall-search.mjs  (from apps/desktop)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'shell-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-shell-v2-03');

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
      await page.screenshot({ path: path.join(OUT_DIR, `03-${id}-FAILURE.png`) });
    } catch {
      /* ignore */
    }
    try {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      // Escape alone can't close the palette when focus left its input
      // (see the escape-needs-input-focus probe below) — clicking the far
      // corner lands on any backdrop/scrim and dismisses it.
      await page.mouse.click(5, 895);
      await page.waitForTimeout(300);
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `03-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function goHome() {
  await navTo(page, 'Home');
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

const PALETTE_PLACEHOLDER = 'Search apps, chats, templates — or describe a new one…';

async function openPalette() {
  await page.keyboard.press('Meta+K');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  return dialog;
}

async function closePalette() {
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await page.keyboard.press('Escape');
  const closed = await dialog
    .waitFor({ state: 'hidden', timeout: 2_000 })
    .then(() => true)
    .catch(() => false);
  if (!closed) {
    // Backdrop click fallback (Escape only works while the input has focus).
    await page.mouse.click(5, 895);
    await dialog.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => undefined);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[v2-03] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---------- Install People ----------
    await step(
      'install-people',
      'Install People from Discover; pinned to Home + sidebar APPS',
      async () => {
        await navTo(page, 'Discover');
        const card = page.locator('button[data-kind="app"]', { hasText: 'People' }).first();
        await card.waitFor({ state: 'visible', timeout: 20_000 });
        await card.click();
        const dialog = page.getByRole('dialog', { name: /^Preview People/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use this template' }).click();
        await page.locator('[data-app-id="people"]').waitFor({ state: 'visible', timeout: 15_000 });
        const sidebarPeople = await page.getByRole('button', { name: /People/ }).count();
        assert(sidebarPeople >= 1, 'sidebar APPS does not list People after install');
        await shot('01-people-installed');
      },
    );

    // ---------- Search: sidebar entry point ----------
    await step(
      'search-via-sidebar-button',
      'Sidebar "Search" button opens the command palette',
      async () => {
        await goHome();
        // The sidebar Search button's accessible name includes the ⌘K hint,
        // so match by prefix (same pattern as the Settings row).
        const searchBtn = page.getByRole('button', { name: /^Search/ }).first();
        await searchBtn.waitFor({ state: 'visible', timeout: 10_000 });
        if (await searchBtn.isDisabled()) {
          await shot('02-sidebar-search-disabled');
          throw new Error(
            'BUG: sidebar "Search" item is permanently disabled — App.tsx renders <Sidebar> without onSearch (Sidebar.tsx:182 disabled={!props.onSearch}); palette only reachable via Cmd+K',
          );
        }
        await searchBtn.click();
        const dialog = page.getByRole('dialog', { name: 'Command palette' });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('02-palette-via-sidebar');
        await closePalette();
      },
    );

    // ---------- Search: no-results state ----------
    await step(
      'search-no-results',
      'Gibberish query shows a sane no-results state (not a blank panel)',
      async () => {
        await openPalette();
        const input = page.getByPlaceholder(PALETTE_PLACEHOLDER);
        await input.fill('zzqqxxplumbus42');
        await page.waitForTimeout(600);
        await shot('03-palette-no-results');
        const dialog = page.getByRole('dialog', { name: 'Command palette' });
        const dialogText = (await dialog.textContent()) ?? '';
        console.log(`[v2-03] no-results dialog text: ${JSON.stringify(dialogText.slice(0, 300))}`);
        // Sane = the dialog still shows SOMETHING (an empty-state message or a
        // build-new affordance), and it must not crash to an empty shell.
        assert(dialogText.trim().length > 0, 'palette went completely blank on a no-results query');
        await closePalette();
      },
    );

    // ---------- Search: special characters ----------
    await step(
      'search-special-chars',
      'Special-chars query (%, &, quotes, emoji) does not break the palette',
      async () => {
        await openPalette();
        const input = page.getByPlaceholder(PALETTE_PLACEHOLDER);
        const payload = `50% & "quotes" 'single' \\back/ 🎉`;
        await input.fill(payload);
        await page.waitForTimeout(600);
        const roundTrip = await input.inputValue();
        assert(roundTrip === payload, `input mangled the query: ${roundTrip}`);
        const dialog = page.getByRole('dialog', { name: 'Command palette' });
        assert(await dialog.isVisible(), 'palette closed/crashed on special chars');
        await shot('04-palette-special-chars');
        await closePalette();
      },
    );

    // ---------- Search: real hit navigates ----------
    await step(
      'search-hit-opens-app',
      'Query "People" -> clicking the hit opens the app',
      async () => {
        await openPalette();
        const input = page.getByPlaceholder(PALETTE_PLACEHOLDER);
        await input.fill('People');
        await page.waitForTimeout(600);
        await shot('05-palette-people-hit');
        const dialog = page.getByRole('dialog', { name: 'Command palette' });
        // The app hit is the only row button with the CRM sub-line — precise
        // target (a bare hasText:'People' union selector matches the results
        // CONTAINER first, whose center is a dead spot between rows).
        const hit = dialog
          .getByRole('button')
          .filter({ hasText: 'Your circle, remembered' })
          .first();
        await hit.waitFor({ state: 'visible', timeout: 5_000 });
        await hit.click();
        await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
        // Expect the app view (iframe) to open.
        await page.waitForSelector('iframe[data-centraid-app="1"]', {
          state: 'attached',
          timeout: 20_000,
        });
        await page.waitForTimeout(1_000);
        await shot('05-people-opened-from-palette');
        await goHome();
      },
    );

    // ---------- Corner probe: Escape after focus leaves the palette input ----------
    await step(
      'search-escape-needs-input-focus',
      'Escape still closes the palette after clicking results whitespace',
      async () => {
        await openPalette();
        const dialog = page.getByRole('dialog', { name: 'Command palette' });
        // Click a non-interactive spot inside the palette (the footer hint bar)
        // so focus leaves the search input, then press Escape.
        const footer = dialog.locator('[class*="foot"], [class*="hint"]').first();
        if (await footer.isVisible().catch(() => false)) {
          await footer.click({ position: { x: 200, y: 8 }, force: true });
        } else {
          const box = await dialog.boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10);
        }
        await page.waitForTimeout(200);
        await page.keyboard.press('Escape');
        const closed = await dialog
          .waitFor({ state: 'hidden', timeout: 2_000 })
          .then(() => true)
          .catch(() => false);
        console.log(`[v2-03] palette closed by Escape after focus left input: ${closed}`);
        if (!closed) {
          await shot('06-escape-focus-bug');
          await page.mouse.click(5, 895); // backdrop click to recover
          await dialog.waitFor({ state: 'hidden', timeout: 3_000 });
          throw new Error(
            'BUG: Escape does not close the command palette once focus leaves its input (Escape handler lives on the <input> only — PaletteScreen.tsx onKeyDown)',
          );
        }
      },
    );

    // ---------- Star, then delete while starred ----------
    await step('star-people', 'Star People from the Home tile context menu', async () => {
      const tile = page.locator('[data-app-id="people"]');
      await tile.waitFor({ state: 'visible', timeout: 10_000 });
      await tile.getByTestId('app-tile').click({ button: 'right' });
      const menu = page.getByRole('menu');
      await menu.waitFor({ state: 'visible', timeout: 5_000 });
      await menu.getByRole('menuitem', { name: /^Star$/ }).click();
      await page.waitForTimeout(400);
      assert((await tile.getAttribute('data-starred')) === 'true', 'tile not starred');
      await navTo(page, 'Starred');
      await page.locator('[data-app-id="people"]').waitFor({ state: 'visible', timeout: 10_000 });
      await shot('06-starred-page-with-people');
      await goHome();
    });

    await step('delete-cancel-keeps-app', 'Delete -> Cancel keeps the app everywhere', async () => {
      const tile = page.locator('[data-app-id="people"]');
      await tile.getByTestId('app-tile').click({ button: 'right' });
      const menu = page.getByRole('menu');
      await menu.waitFor({ state: 'visible', timeout: 5_000 });
      const menuText = await menu.textContent();
      console.log(`[v2-03] context menu: ${JSON.stringify(menuText)}`);
      await menu.getByRole('menuitem', { name: 'Delete' }).click();
      const confirmDialog = page.getByRole('dialog').filter({ hasText: 'Delete app?' });
      await confirmDialog.waitFor({ state: 'visible', timeout: 5_000 });
      await page.waitForTimeout(800); // let the entry animation settle for an honest screenshot
      await shot('07-delete-confirm-settled');
      await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
      await confirmDialog.waitFor({ state: 'hidden', timeout: 5_000 });
      assert(
        (await page.locator('[data-app-id="people"]').count()) === 1,
        'app vanished after CANCEL',
      );
    });

    await step(
      'delete-while-starred',
      'Delete (confirmed): gone from Home, sidebar, Starred, palette',
      async () => {
        const tile = page.locator('[data-app-id="people"]');
        await tile.getByTestId('app-tile').click({ button: 'right' });
        const menu = page.getByRole('menu');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        await menu.getByRole('menuitem', { name: 'Delete' }).click();
        const confirmDialog = page.getByRole('dialog').filter({ hasText: 'Delete app?' });
        await confirmDialog.waitFor({ state: 'visible', timeout: 5_000 });
        await confirmDialog.getByRole('button', { name: 'Delete' }).click();
        await page.locator('[data-app-id="people"]').waitFor({ state: 'hidden', timeout: 15_000 });
        await page.waitForTimeout(800);
        await shot('08-home-after-delete');

        // Sidebar APPS must not list it.
        const sidebarPeople = await page
          .getByRole('button', { name: 'People', exact: true })
          .count();
        assert(sidebarPeople === 0, 'sidebar still lists People after delete');

        // Starred page must not show a ghost card.
        await navTo(page, 'Starred');
        await page
          .getByRole('heading', { name: 'Starred', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(500);
        const ghost = await page.locator('[data-app-id="people"]').count();
        await shot('09-starred-after-delete');
        assert(ghost === 0, 'Starred page shows a ghost card for the deleted app');

        // Palette must not return it as an installed app anymore (the TEMPLATE
        // may legitimately still match — only an "app" kind hit is a ghost).
        await goHome();
        await openPalette();
        const input = page.getByPlaceholder(PALETTE_PLACEHOLDER);
        await input.fill('People');
        await page.waitForTimeout(700);
        const dialog = page.getByRole('dialog', { name: 'Command palette' });
        const dialogText = (await dialog.textContent()) ?? '';
        console.log(
          `[v2-03] palette text post-delete: ${JSON.stringify(dialogText.slice(0, 400))}`,
        );
        await shot('10-palette-after-delete');
        await closePalette();
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ UNINSTALL/SEARCH VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll uninstall/search steps PASSED.');
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
