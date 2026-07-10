#!/usr/bin/env node
// Verify fix #2: knowledge.create_notebook now has a name_unused precondition
// (packages/vault/src/commands/knowledge.ts) so creating a second notebook
// with a name that collides with an existing one is refused with a friendly
// message, instead of silently succeeding (two indistinguishable notebooks)
// or surfacing a raw precondition string.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-02');

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
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v02-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v02-${name}.png`);
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
    await step('open-notes', 'Open Notes iframe', async () => {
      await page.locator('[data-app-id="notes"]').getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
      frame = frameLoc(page);
      await frame.locator('.nt-nav-item, [aria-label="New notebook"]').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(600);
    });

    await step('create-first-scratchpad', 'Create notebook "Scratchpad"', async () => {
      await frame.locator('button[aria-label="New notebook"]').click();
      const input = frame.locator('input[aria-label="Notebook name"]');
      await input.waitFor({ state: 'visible', timeout: 5000 });
      await input.fill('Scratchpad');
      await frame.locator('button[type="submit"]', { hasText: 'Create' }).click();
      await page.waitForTimeout(600);
      await shot('01-scratchpad-created');
      const nbItem = frame.locator('.nt-nb-name', { hasText: 'Scratchpad' });
      await nbItem.waitFor({ state: 'visible', timeout: 5000 });
      const count = await frame.locator('.nt-nb-name', { hasText: 'Scratchpad' }).count();
      assert(count === 1, `expected exactly 1 "Scratchpad" notebook after first create, got ${count}`);
    });

    await step('duplicate-refused-friendly', 'Creating a SECOND "Scratchpad" is refused with a friendly message, not a raw error or silent success', async () => {
      await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click().catch(() => undefined);
      await page.waitForTimeout(300);
      await frame.locator('button[aria-label="New notebook"]').click();
      const input = frame.locator('input[aria-label="Notebook name"]');
      await input.waitFor({ state: 'visible', timeout: 5000 });
      await input.fill('Scratchpad');
      await shot('02-duplicate-name-typed');
      await frame.locator('button[type="submit"]', { hasText: 'Create' }).click();
      await page.waitForTimeout(700);
      await shot('03-after-duplicate-create-attempt');

      const noticeText = await frame.locator('#noticeBanner').textContent().catch(() => '');
      console.log(`[v02] noticeBanner after duplicate create attempt: ${JSON.stringify(noticeText)}`);
      assert(
        /already have a notebook with that name/i.test(noticeText ?? ''),
        `expected friendly refusal "You already have a notebook with that name.", got: ${JSON.stringify(noticeText)}`,
      );
      // Must not be the raw precondition string leaking through.
      assert(!/name_unused/i.test(noticeText ?? ''), `raw precondition name leaked into the UI: ${JSON.stringify(noticeText)}`);

      // Only ONE "Scratchpad" notebook must exist -- the duplicate must not
      // have silently succeeded.
      const count = await frame.locator('.nt-nb-name', { hasText: 'Scratchpad' }).count();
      console.log(`[v02] "Scratchpad" notebook count after duplicate attempt: ${count}`);
      assert(count === 1, `expected still exactly 1 "Scratchpad" notebook (duplicate refused), got ${count}`);
    });

    // ---- Report ----
    console.log('\n================ VERIFY-02 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-02 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v02-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v02] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
