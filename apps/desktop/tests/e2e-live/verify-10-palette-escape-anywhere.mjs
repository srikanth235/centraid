#!/usr/bin/env node
// Verify fix #10: the command palette now closes on Escape no matter where
// focus sits (apps/desktop/src/renderer/react/screens/PaletteScreen.tsx adds
// a document-level keydown listener for Escape, instead of relying solely on
// the input's onKeyDown -- which only fired while the input itself had
// focus, stranding the palette open once focus moved to the results list or
// footer hint bar).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-10');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v10-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v10-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  page.setDefaultTimeout(60_000);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('open-palette', 'Open the palette via Cmd+K', async () => {
      await page.keyboard.press('Meta+K');
      await page.waitForTimeout(400);
      const dialogVisible = await page
        .locator('[role="dialog"]')
        .first()
        .isVisible()
        .catch(() => false);
      assert(dialogVisible, 'palette did not open via Cmd+K');
      await shot('01-palette-open');
    });

    await step(
      'escape-after-blurring-input',
      'Click empty whitespace inside the palette (moves focus off the input), then Escape must still close it',
      async () => {
        const dialog = page.locator('[role="dialog"]').first();
        // Click the footer hint bar area -- not the input, not a result row --
        // to move focus off the search input without triggering navigation.
        const footer = dialog.locator('text=navigate').first();
        const footerVisible = await footer.isVisible().catch(() => false);
        if (footerVisible) {
          await footer.click({ position: { x: 2, y: 2 } }).catch(() => undefined);
        } else {
          // Fallback: click the dialog's own empty padding area near an edge.
          const box = await dialog.boundingBox();
          if (box) await page.mouse.click(box.x + 5, box.y + box.height - 5);
        }
        await page.waitForTimeout(200);

        const activeTag = await page.evaluate(() => document.activeElement?.tagName ?? null);
        const activeIsInput = await page.evaluate(
          () => document.activeElement?.tagName === 'INPUT',
        );
        console.log(
          `[v10] active element after clicking whitespace: ${activeTag}, is the search input: ${activeIsInput}`,
        );
        await shot('02-focus-moved-off-input');

        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
        await shot('03-after-escape');

        const stillOpen = await page
          .locator('[role="dialog"]')
          .first()
          .isVisible()
          .catch(() => false);
        console.log(`[v10] palette still visible after Escape (blurred-input case): ${stillOpen}`);
        assert(
          !stillOpen,
          'palette did NOT close on Escape when focus was off the input -- fix #10 regressed or never worked',
        );
      },
    );

    // ---- Report ----
    console.log('\n================ VERIFY-10 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-10 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v10-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v10] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
