#!/usr/bin/env node
// Verify the "What's new" changelog feature end-to-end against the REAL app:
//  1. The sidebar "What's new" item opens the modal, and the real
//     IPC -> main (GitHub Releases fetch) chain resolves. srikanth235/centraid
//     has no published releases yet, so this exercises the graceful empty state.
//  2. The modal dismisses on Escape and on the close button.
//
// Rich rendering (release sections, md-lite notes, the "Installed" tag) is
// covered by the jsdom unit test (WhatsNewModal.test.tsx): the contextBridge
// surface is frozen, so it can't be monkeypatched from the page here — the
// only way to feed real notes through the live IPC path is a real repo with
// published releases, which this repo doesn't have yet.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-14');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v14-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v14-${name}.png`);
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

    await step('sidebar-item', 'Sidebar "What\'s new" item opens the modal (real GitHub fetch)', async () => {
      const btn = page.getByRole('button', { name: /What.s new/i }).first();
      await btn.waitFor({ state: 'visible', timeout: 10_000 });
      await btn.click();
      const dialog = page.getByRole('dialog', { name: /What.s new/i });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      // Real repo has no releases yet -> graceful empty (or a transient load).
      await page.waitForTimeout(1200);
      await shot('01-live-empty-state');
      const bodyText = await dialog.textContent();
      console.log(`[v14] live modal text: ${bodyText?.slice(0, 120)}`);
      assert(
        /No releases published yet|Loading release notes/.test(bodyText ?? ''),
        'live modal did not show the empty/loading state',
      );
    });

    await step('escape-closes', 'Escape dismisses the modal', async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const visible = await page
        .getByRole('dialog', { name: /What.s new/i })
        .isVisible()
        .catch(() => false);
      assert(!visible, 'modal still visible after Escape');
    });

    await step('close-button', 'Close button dismisses the reopened modal', async () => {
      await page.getByRole('button', { name: /What.s new/i }).first().click();
      const dialog = page.getByRole('dialog', { name: /What.s new/i });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await page.getByRole('button', { name: 'Close' }).click();
      await page.waitForTimeout(300);
      const visible = await dialog.isVisible().catch(() => false);
      await shot('02-after-close');
      assert(!visible, 'modal still visible after clicking Close');
    });

    console.log('\n================ VERIFY-14 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-14 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v14-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v14] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
