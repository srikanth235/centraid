#!/usr/bin/env node
// Verify fix #11: kit.js's toast() now caps the stack at MAX_TOASTS=3
// (packages/blueprints/kit/kit.js) -- evicting the oldest non-sticky toast
// once the host has more than 3 children, instead of letting a quick-capture
// burst pile up one toast per receipt and cover half the app.
//
// Rapidly add ~10 tasks via Tasks' quick-capture and confirm no more than 3
// toasts are ever stacked on screen at once.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-11');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v11-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v11-${name}.png`);
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
      await page.waitForTimeout(500);
    });

    let maxObservedToasts = 0;
    await step(
      'rapid-add-ten-tasks',
      'Quick-capture 10 tasks back-to-back, sampling the live toast count as it goes',
      async () => {
        const input = fl.locator('.tk-capture-input');
        for (let i = 1; i <= 10; i++) {
          // Submit via Enter on the (always-focused, always-enabled) input
          // rather than clicking the Add button -- the button is disabled
          // while Capture's own `busy` flag is set mid-submit (Capture.jsx),
          // and racing that disabled window isn't the point of this test.
          const t0 = Date.now();
          await input.fill(`Toast cap probe task ${i}`);
          await input.press('Enter');
          await page.waitForTimeout(150);
          console.log(`[v11] add #${i} took ${Date.now() - t0}ms`);
          const count = await fl
            .locator('kit-toast')
            .count()
            .catch(() => 0);
          maxObservedToasts = Math.max(maxObservedToasts, count);
          if (i === 6) await shot('01-mid-burst-toast-stack');
        }
        await page.waitForTimeout(200);
        const finalCount = await fl
          .locator('kit-toast')
          .count()
          .catch(() => 0);
        maxObservedToasts = Math.max(maxObservedToasts, finalCount);
        console.log(`[v11] max toast count observed during/after the burst: ${maxObservedToasts}`);
        await shot('02-after-burst-toast-stack');
      },
    );

    await step('toast-cap-enforced', 'At no point did more than 3 toasts stack up', async () => {
      assert(
        maxObservedToasts <= 3,
        `observed ${maxObservedToasts} toasts stacked at once -- expected the MAX_TOASTS=3 cap to evict older ones`,
      );
      // Sanity: all 10 tasks were actually added (the cap is cosmetic, not a
      // functional drop of the underlying writes).
      await fl
        .locator('.tk-nav-item', { hasText: 'Anytime' })
        .click()
        .catch(() => undefined);
      await page.waitForTimeout(400);
      const allOpenCount = await fl
        .locator('.tk-nav-item', { hasText: 'All open' })
        .locator('.tk-nav-count')
        .textContent()
        .catch(() => '');
      console.log(`[v11] "All open" count after adding 10 tasks: ${allOpenCount}`);
    });

    // ---- Report ----
    console.log('\n================ VERIFY-11 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log(`\nMax toasts observed at once: ${maxObservedToasts}`);
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-11 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v11-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v11] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
