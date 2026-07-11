#!/usr/bin/env node
// Verify fix #6: Notes card title/body overflow-wrap fix
// (packages/blueprints/apps/notes/app.css .nt-card-title / .nt-card-body now
// have `overflow-wrap: anywhere`). Create a note whose title is a 300+
// character string with NO spaces (nothing to break on otherwise) and
// confirm the card wraps cleanly instead of blowing out the layout /
// forcing a page-wide horizontal scrollbar.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-06');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v06-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v06-${name}.png`);
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
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
      frame = frameLoc(page);
      await frame.locator('.nt-qa-title').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(600);
    });

    const longTitle = 'a'.repeat(320) + 'ZZZEND';
    await step(
      'create-long-title-note',
      'Quick-add a note with a 320+ char unbroken (no-spaces) title',
      async () => {
        const titleInput = frame.locator('.nt-qa-title');
        await titleInput.fill(longTitle);
        await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
        await page.waitForTimeout(700);
        const card = frame.locator('.nt-card', { hasText: 'ZZZEND' });
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('01-long-title-card');
      },
    );

    await step(
      'no-horizontal-overflow',
      'Card renders with wrapped text -- no horizontal scrollbar / layout blowout',
      async () => {
        // 1) The renderer's own document must not have horizontal overflow.
        const pageOverflow = await page.evaluate(() => {
          const de = document.documentElement;
          return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
        });
        console.log(
          `[v06] shell document scrollWidth=${pageOverflow.scrollWidth} clientWidth=${pageOverflow.clientWidth}`,
        );
        assert(
          pageOverflow.scrollWidth <= pageOverflow.clientWidth + 2,
          `shell document has horizontal overflow: scrollWidth=${pageOverflow.scrollWidth} > clientWidth=${pageOverflow.clientWidth}`,
        );

        // 2) Inside the app iframe's own document, same check.
        const appFrame = page
          .frames()
          .find((f) => f.url().includes('notes') || f !== page.mainFrame());
        const frameOverflow = await frame.locator('body').evaluate(() => {
          const de = document.documentElement;
          return { scrollWidth: de.scrollWidth, clientWidth: de.clientWidth };
        });
        console.log(
          `[v06] notes iframe document scrollWidth=${frameOverflow.scrollWidth} clientWidth=${frameOverflow.clientWidth}`,
        );
        assert(
          frameOverflow.scrollWidth <= frameOverflow.clientWidth + 2,
          `notes app document has horizontal overflow: scrollWidth=${frameOverflow.scrollWidth} > clientWidth=${frameOverflow.clientWidth}`,
        );

        // 3) The card title element itself must not be wider than its card
        // container (the specific overflow-wrap:anywhere fix).
        const titleEl = frame.locator('.nt-card-title', { hasText: 'ZZZEND' });
        const box = await titleEl.evaluate((el) => ({
          elWidth: el.getBoundingClientRect().width,
          scrollWidth: el.scrollWidth,
          parentWidth: el.closest('.nt-card')?.getBoundingClientRect().width ?? 0,
        }));
        console.log(`[v06] title element box: ${JSON.stringify(box)}`);
        assert(
          box.scrollWidth <= box.parentWidth + 4,
          `card title overflows its card container: title scrollWidth=${box.scrollWidth} > card width=${box.parentWidth}`,
        );

        await shot('02-zoom-long-title-card');
      },
    );

    // ---- Report ----
    console.log('\n================ VERIFY-06 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-06 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v06-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v06] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
