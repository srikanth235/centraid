#!/usr/bin/env node
// Verify fix #5: Tasks search is no longer scoped to the current focus view
// (packages/blueprints/apps/tasks/logic.js buildSections -- `searching`
// bypasses the VIEW_BUCKETS allow-list). Add a task due TOMORROW (lands in
// the "week" bucket, excluded from the "Anytime" undated-only view), switch
// to Anytime, then search for its title -- it must still surface.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-05');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v05-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v05-${name}.png`);
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

    await step('install-tasks', 'Discover -> install Tasks', async () => {
      await navTo(page, 'Discover');
      const card = page.locator('button[data-kind="app"]', { hasText: 'Tasks' }).first();
      await card.waitFor({ state: 'visible', timeout: 20_000 });
      await card.click();
      const dialog = page.getByRole('dialog', { name: /^Preview Tasks/ });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Use this template' }).click();
      await page.locator('[data-app-id="tasks"]').waitFor({ state: 'visible', timeout: 15_000 });
    });

    let fl;
    await step('open-tasks', 'Open Tasks iframe', async () => {
      await page.locator('[data-app-id="tasks"]').getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
      fl = frameLoc(page);
      await fl.locator('.tk-capture-input').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(600);
    });

    const title = 'Call the landlord about the lease renewal';
    await step('add-task-due-tomorrow', `Quick-capture "${title}" with due=Tomorrow`, async () => {
      const input = fl.locator('.tk-capture-input');
      await input.fill(title);
      await fl.locator('.tk-capture-seg button', { hasText: 'Tmrw' }).first().click();
      await fl.locator('.tk-capture-add').click();
      await page.waitForTimeout(600);
      await shot('01-task-added-due-tomorrow');
    });

    await step(
      'switch-to-anytime-view',
      'Switch to "Anytime" view (undated-only bucket) -- task should NOT appear here',
      async () => {
        await fl.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
        await page.waitForTimeout(400);
        await shot('02-anytime-view-task-excluded');
        const rowCount = await fl.locator('.tk-row', { hasText: 'landlord' }).count();
        console.log(
          `[v05] "landlord" task visible in Anytime view (should be 0, it's due tomorrow): ${rowCount}`,
        );
        assert(
          rowCount === 0,
          'sanity check: the tomorrow-due task should NOT show in the Anytime (undated) view',
        );
      },
    );

    await step(
      'search-surfaces-task-from-anytime',
      'Search for the title WHILE still on Anytime -- must surface the match (the fix)',
      async () => {
        const searchInput = fl.locator('#searchInput');
        await searchInput.fill('landlord');
        await page.waitForTimeout(500);
        await shot('03-search-from-anytime-view');
        const rows = fl.locator('.tk-rows .tk-row, .tk-row');
        const count = await rows.count();
        console.log(`[v05] search "landlord" rows while on Anytime view: ${count}`);
        assert(
          count >= 1,
          'search for "landlord" (a task due TOMORROW) returned NO rows while on the Anytime view -- search is still wrongly scoped to the current view',
        );
        const matchText = await fl.locator('.tk-row', { hasText: 'landlord' }).count();
        assert(matchText >= 1, 'the landlord task specifically must be among the search results');
      },
    );

    // ---- Report ----
    console.log('\n================ VERIFY-05 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-05 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v05-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v05] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
