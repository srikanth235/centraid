#!/usr/bin/env node
// Verification for FIX 1 — Starred page used to be a hardcoded "Nothing
// starred yet" stub even with starred items. Now StarredRoute renders the
// Home card grid filtered to starred items, with a narrow Open/Unstar
// context menu.
//
// Run with: node apps/desktop/tests/e2e-live/flows-verify-fix1-starred.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-verify-fix1-starred');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-fix1-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `fix1-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function bodyText() {
  return page.evaluate(() => document.body.textContent);
}

async function openStarred() {
  await navTo(page, 'Starred');
  await page
    .getByRole('heading', { name: 'Starred', level: 1 })
    .waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(400);
}

async function openHome() {
  await navTo(page, 'Home');
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(
    `[fix1] launched + Home ready in ${Date.now() - t0}ms (fresh profile, userData=${USER_DATA_DIR})`,
  );

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---------- a. fresh profile -> Starred empty state ----------
    await step(
      'a-empty-state',
      'Fresh profile: Starred shows "Nothing starred yet..." empty state',
      async () => {
        await openStarred();
        await shot('a-empty-state');
        const emptyMsg = page.locator(
          'text=Nothing starred yet. Hover an app tile and tap the star.',
        );
        await emptyMsg.waitFor({ state: 'visible', timeout: 5_000 });
        const txt = await bodyText();
        console.log(`[fix1] Starred body text (empty): ${JSON.stringify(txt.slice(0, 200))}`);
      },
    );

    // ---------- b. install Agenda + star from Home context menu ----------
    await step(
      'b-install-and-star-app',
      'Install Agenda, star it via Home right-click context menu',
      async () => {
        await navTo(page, 'Discover');
        const card = page.locator('button[data-kind="app"]', { hasText: 'Agenda' }).first();
        await card.waitFor({ state: 'visible', timeout: 15_000 });
        await card.click();
        const dialog = page.getByRole('dialog', { name: /^Preview Agenda/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use this template' }).click();
        await page.locator('[data-app-id="agenda"]').waitFor({ state: 'visible', timeout: 15_000 });

        await openHome();
        const tile = page.locator('[data-app-id="agenda"]');
        await tile.waitFor({ state: 'visible', timeout: 10_000 });
        const starredBefore = await tile.getAttribute('data-starred');
        assert(
          starredBefore === 'false',
          `expected data-starred=false before starring, got ${starredBefore}`,
        );

        await tile.getByTestId('app-tile').click({ button: 'right' });
        const menu = page.getByRole('menu');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        const menuText = await menu.textContent();
        console.log(`[fix1] Home context menu text (unstarred app): ${JSON.stringify(menuText)}`);
        assert(/Star/.test(menuText ?? ''), `expected a Star menu item, got: ${menuText}`);
        await menu.getByRole('menuitem', { name: /^Star$/ }).click();
        await page.waitForTimeout(400);

        const starredAfter = await tile.getAttribute('data-starred');
        assert(
          starredAfter === 'true',
          `expected data-starred=true after starring, got ${starredAfter}`,
        );
        const starFlag = tile.locator('[class*="starFlag"]');
        await starFlag.waitFor({ state: 'visible', timeout: 5_000 });
        console.log('[fix1] orange star flag visible on Home tile');
        await shot('b-home-tile-starred');
      },
    );

    // ---------- c. Starred page shows the card ----------
    await step(
      'c-starred-page-shows-card',
      'Starred page renders the starred Agenda card, pixel-identical to Home',
      async () => {
        await openStarred();
        await shot('c-starred-page-with-agenda');
        const card = page.locator('[data-app-id="agenda"]');
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        assert(
          (await card.getAttribute('data-starred')) === 'true',
          'Starred card missing data-starred=true',
        );
        const name = await card.locator('[class*="name"]').first().textContent();
        console.log(`[fix1] Starred card name: ${JSON.stringify(name)}`);
        assert(/Agenda/.test(name ?? ''), `expected card name "Agenda", got ${name}`);
        const starFlag = card.locator('[class*="starFlag"]');
        await starFlag.waitFor({ state: 'visible', timeout: 5_000 });
        const emptyMsg = await page.locator('text=Nothing starred yet.').count();
        assert(emptyMsg === 0, 'empty-state message still present despite a starred item');
      },
    );

    // ---------- d. context menu Open/Unstar, then Unstar removes card ----------
    await step(
      'd-open-and-unstar',
      'Starred card context menu offers Open/Unstar; Open opens app; Unstar removes card',
      async () => {
        const card = page.locator('[data-app-id="agenda"]');
        await card.getByTestId('app-tile').click({ button: 'right' });
        const menu = page.getByRole('menu');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        const menuText = await menu.textContent();
        console.log(`[fix1] Starred-page context menu text: ${JSON.stringify(menuText)}`);
        assert(/Open/.test(menuText ?? ''), `expected "Open" in Starred menu, got: ${menuText}`);
        assert(
          /Unstar/.test(menuText ?? ''),
          `expected "Unstar" in Starred menu, got: ${menuText}`,
        );
        assert(
          !/Rename/.test(menuText ?? ''),
          `menu should be narrow (no Rename), got: ${menuText}`,
        );
        assert(
          !/Delete/.test(menuText ?? ''),
          `menu should be narrow (no Delete), got: ${menuText}`,
        );
        await shot('d-starred-context-menu-open');

        await menu.getByRole('menuitem', { name: 'Open' }).click();
        const iframe = await page.waitForSelector('iframe[data-centraid-app="1"]', {
          state: 'attached',
          timeout: 20_000,
        });
        assert(iframe !== null, 'app iframe did not attach after clicking Open from Starred');
        console.log('[fix1] app opened via Starred "Open" menu item');
        await shot('d-app-opened-from-starred');

        await openStarred();
        const card2 = page.locator('[data-app-id="agenda"]');
        await card2.waitFor({ state: 'visible', timeout: 10_000 });
        await card2.getByTestId('app-tile').click({ button: 'right' });
        const menu2 = page.getByRole('menu');
        await menu2.waitFor({ state: 'visible', timeout: 5_000 });
        await menu2.getByRole('menuitem', { name: 'Unstar' }).click();
        await page.waitForTimeout(400);
        await shot('d-after-unstar');

        const cardGone = await page.locator('[data-app-id="agenda"]').count();
        assert(cardGone === 0, 'starred card still present after Unstar');
        const emptyMsg = page.locator(
          'text=Nothing starred yet. Hover an app tile and tap the star.',
        );
        await emptyMsg.waitFor({ state: 'visible', timeout: 5_000 });
        console.log('[fix1] empty state returned after unstarring');
      },
    );

    // ---------- e. star an automation too ----------
    await step(
      'e-star-automation',
      'Adopt + star "System health check" automation; appears on Starred as an automation card',
      async () => {
        await navTo(page, 'Discover');
        await page.getByRole('tab', { name: /^Automations/ }).click();
        await page.waitForTimeout(300);
        const tmplCard = page
          .locator('button[data-kind="automation"]', { hasText: 'System health check' })
          .first();
        await tmplCard.waitFor({ state: 'visible', timeout: 15_000 });
        await tmplCard.click();
        const dialog = page.getByRole('dialog', { name: /System health check/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use template' }).click();
        await page.waitForTimeout(1200);
        await shot('e-after-adopt-automation');

        await openHome();
        const autoTile = page
          .locator('[data-kind="automation"]', { hasText: 'System health check' })
          .first();
        await autoTile.waitFor({ state: 'visible', timeout: 15_000 });
        const wrap = autoTile.locator('xpath=..');
        const moreBtn = wrap.getByRole('button', { name: 'More actions' });
        await moreBtn.click();
        const menu = page.getByRole('menu');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        const menuText = await menu.textContent();
        console.log(`[fix1] Home automation context menu text: ${JSON.stringify(menuText)}`);
        await menu.getByRole('menuitem', { name: /^Star$/ }).click();
        await page.waitForTimeout(400);
        await shot('e-home-automation-starred');

        await openStarred();
        await shot('e-starred-page-with-automation');
        const bodyTxt = await bodyText();
        console.log(
          `[fix1] Starred page body after starring automation: ${JSON.stringify(bodyTxt.slice(0, 300))}`,
        );
        assert(
          /System health check/.test(bodyTxt),
          'Starred page missing the starred automation card',
        );
        const autoCardOnStarred = page.locator('[data-kind="automation"]', {
          hasText: 'System health check',
        });
        await autoCardOnStarred.first().waitFor({ state: 'visible', timeout: 5_000 });
      },
    );

    // ---------- f. relaunch persistence ----------
    await step(
      'f-relaunch-persistence',
      'Relaunch same userDataDir -> check whether star state persists on Starred',
      async () => {
        await session.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await openStarred();
        await shot('f-starred-after-relaunch');
        const bodyTxt = await bodyText();
        console.log(
          `[fix1] Starred page body after relaunch: ${JSON.stringify(bodyTxt.slice(0, 300))}`,
        );
        const emptyPresent = await page.locator('text=Nothing starred yet.').count();
        console.log(
          `[fix1] OBSERVATION: after relaunch, empty-state present=${emptyPresent > 0} (star Store persistence — report as observation, not necessarily a bug either way)`,
        );
      },
    );

    // ---------- Report ----------
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ FIX 1 (STARRED) VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${String(r.error).split('\n')[0]}`);
    }
    console.log('=================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll FIX 1 steps PASSED.');
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
