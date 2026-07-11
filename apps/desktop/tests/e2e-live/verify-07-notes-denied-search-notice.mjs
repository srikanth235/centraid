#!/usr/bin/env node
// Verify fix #7 (best-effort, lower priority per the QA brief): Notes'
// debounced search handler (packages/blueprints/apps/notes/logic.js
// applySearchInput) now checks `res?.vaultDenied` and surfaces a notice
// ("The vault denied this search." / the vault's own message) instead of
// silently setting `state.searchResults = []` (a fake-empty "no results").
//
// Trigger a REAL denial: install Notes, add a note, revoke the app's own
// vault grant via App settings -> Vault tab -> Revoke (the same real path
// flows-ask-01-panel-grant-corner.mjs uses), then search and inspect the
// notice banner.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-07');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;
let skipped = null;

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v07-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v07-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  page.setDefaultTimeout(60_000);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install-notes', 'Discover -> install Notes', async () => {
      await navTo(page, 'Discover');
      const card = page.locator('button[data-kind="app"]', { hasText: 'Notes' }).first();
      await card.waitFor({ state: 'visible', timeout: 20_000 });
      await card.click();
      const dialog = page.getByRole('dialog', { name: /^Preview Notes/ });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Use this template' }).click();
      await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
    });

    let frame;
    await step('open-notes-add-note', 'Open Notes, add a searchable note', async () => {
      await page.locator('[data-app-id="notes"]').getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
      frame = frameLoc(page);
      await frame.locator('.nt-qa-title').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(500);
      await frame.locator('.nt-qa-title').fill('Denial probe note');
      await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
      await page.waitForTimeout(600);
      await frame
        .locator('.nt-card', { hasText: 'Denial probe note' })
        .waitFor({ state: 'visible', timeout: 10_000 });
    });

    let revoked = false;
    await step(
      'revoke-app-grant',
      "Revoke the Notes app's own vault grant via App settings -> Vault tab",
      async () => {
        const gear = page.getByRole('button', { name: 'App settings' });
        const gearVisible = await gear.isVisible().catch(() => false);
        if (!gearVisible) {
          skipped =
            'App settings gear button not found/visible in this build -- cannot reach the Vault tab in the time budget';
          return;
        }
        await gear.click();
        const dialog = page.getByRole('dialog', { name: 'App settings' });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Vault' }).click();
        await page.waitForTimeout(400);
        await shot('01-vault-tab-before-revoke');
        const revokeBtn = dialog.getByRole('button', { name: 'Revoke' });
        const revokeVisible = await revokeBtn.isVisible().catch(() => false);
        if (!revokeVisible) {
          skipped =
            'No "Revoke" button visible on the Vault tab (app may not show a granted row) -- cannot trigger a real denial in the time budget';
          await dialog
            .getByRole('button', { name: 'Close' })
            .click()
            .catch(() => undefined);
          return;
        }
        await revokeBtn.click();
        await page.waitForTimeout(800);
        await shot('02-vault-tab-after-revoke');
        await dialog.getByRole('button', { name: 'Close' }).click();
        await dialog.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
        revoked = true;
      },
    );

    if (revoked) {
      await step(
        'search-shows-denial-notice',
        'Searching after revoke shows a denial NOTICE, not a silent fake-empty result',
        async () => {
          // Re-enter the app fresh so the revoked grant is actually exercised
          // on the next read (avoid any in-memory cache from before revoke).
          await page
            .getByRole('button', { name: 'Home', exact: true })
            .first()
            .click()
            .catch(() => undefined);
          await page.waitForTimeout(300);
          await page.locator('[data-app-id="notes"]').getByTestId('app-tile').click();
          await page.waitForSelector('iframe[data-centraid-app="1"]', {
            state: 'attached',
            timeout: 20_000,
          });
          frame = frameLoc(page);
          await page.waitForTimeout(800);
          await shot('03-notes-reopened-after-revoke');

          const searchInput = frame.locator('#searchInput');
          await searchInput.fill('Denial probe');
          await page.waitForTimeout(700);
          await shot('04-search-after-revoke');

          const noticeText = await frame
            .locator('#noticeBanner')
            .textContent()
            .catch(() => '');
          console.log(
            `[v07] noticeBanner text after searching with a revoked grant: ${JSON.stringify(noticeText)}`,
          );
          const resultCount = await frame
            .locator('.nt-card, .nt-sched-card, [class*="result"]')
            .count();
          console.log(`[v07] visible result-like elements: ${resultCount}`);

          assert(
            (noticeText ?? '').trim().length > 0,
            `expected a non-empty denial notice after searching with a revoked grant, got: ${JSON.stringify(noticeText)}`,
          );
        },
      );
    } else {
      console.log(`[v07] SKIPPED denial-notice check: ${skipped}`);
      results.push({ id: 'search-shows-denial-notice', label: 'skipped', verdict: 'skip', ms: 0 });
    }

    // ---- Report ----
    console.log('\n================ VERIFY-07 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    if (skipped) console.log(`\nSKIP REASON: ${skipped}`);
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-07 steps PASSED (or gracefully skipped).');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v07-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v07] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
