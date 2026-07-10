#!/usr/bin/env node
// Verify fix #9: the sidebar's "Search" nav item now works
// (apps/desktop/src/renderer/react/shell/App.tsx passes onSearch={() =>
// setPaletteOpen(true)} into <Sidebar/>; Sidebar.tsx's Search button is
// `disabled={!props.onSearch}`, so before the fix -- with no onSearch prop
// wired at all -- the button was permanently greyed out/disabled).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-09');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v09-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v09-${name}.png`);
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

    await step('search-button-enabled', 'Sidebar "Search" nav item is NOT disabled', async () => {
      const searchBtn = page.getByRole('button', { name: /^Search/ }).first();
      await searchBtn.waitFor({ state: 'visible', timeout: 10_000 });
      const disabled = await searchBtn.isDisabled();
      console.log(`[v09] Sidebar Search button disabled: ${disabled}`);
      await shot('01-sidebar-search-button');
      assert(!disabled, 'sidebar Search nav item is disabled -- onSearch was not wired');
    });

    await step('search-click-opens-palette', 'Clicking Search opens the command palette', async () => {
      const searchBtn = page.getByRole('button', { name: /^Search/ }).first();
      await searchBtn.click();
      await page.waitForTimeout(400);
      await shot('02-palette-opened-via-search-button');
      const paletteInput = page.locator('input[placeholder], [role="dialog"] input').first();
      const paletteVisible = await page.locator('[role="dialog"]').first().isVisible().catch(() => false);
      console.log(`[v09] a dialog (palette) is visible after clicking Search: ${paletteVisible}`);
      assert(paletteVisible, 'clicking the sidebar Search button did not open any dialog/palette');
    });

    // ---- Report ----
    console.log('\n================ VERIFY-09 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-09 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v09-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v09] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
