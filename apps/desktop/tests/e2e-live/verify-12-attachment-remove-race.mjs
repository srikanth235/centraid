#!/usr/bin/env node
// Verify fix #12: kit.js's renderAttachments() now carries an armed
// remove-confirm button's state across an imperative rebuild
// (packages/blueprints/kit/kit.js -- reads
// `.kit-attach-remove[data-kit-armed="true"]` before wiping stripEl's
// innerHTML and re-arms the matching fresh button). Notes wires
// `window.addEventListener('focus', refresh)` (chrome.js), and refresh()
// re-renders the open note's editor -- including AttachStrip's imperative
// renderAttachments() call -- so a window-focus event landing between the
// "arm" click and the "confirm" click used to silently reset the remove
// button, turning the owner's second click into a no-op re-arm instead of
// an actual delete.
//
// Repro: attach a file, arm the remove button (first click), fire a
// synthetic window 'focus' event on the iframe (simulating the refresh race
// window.addEventListener('focus', refresh) opens), then click remove again
// -- it must actually delete the attachment on that single second click.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-12');

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v12-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v12-${name}.png`);
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

  const tmpFile = path.join(OUT_DIR, 'attach-race-probe.txt');
  await fs.writeFile(tmpFile, 'attachment remove-race probe file\n');

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
    await step('create-note-and-open-editor', 'Quick-add a note, open its editor', async () => {
      await page.locator('[data-app-id="notes"]').getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
      frame = frameLoc(page);
      await frame.locator('.nt-qa-title').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(500);
      await frame.locator('.nt-qa-title').fill('Attachment race probe note');
      await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
      await page.waitForTimeout(600);
      await frame.locator('.nt-card', { hasText: 'Attachment race probe note' }).click();
      await frame.locator('.nt-editor').waitFor({ state: 'visible', timeout: 10_000 });
    });

    await step('attach-a-file', 'Attach a real file via the hidden file input', async () => {
      const [fileChooser] = await Promise.all([
        page.waitForEvent('filechooser').catch(() => null),
        frame.locator('.nt-attach-btn', { hasText: 'Attach a file' }).click(),
      ]);
      if (fileChooser) {
        await fileChooser.setFiles(tmpFile);
      } else {
        // Fallback: set files directly on the (hidden) input element.
        await frame.locator('#attachInput').setInputFiles(tmpFile);
      }
      await page.waitForTimeout(1000);
      const tile = frame.locator('.kit-attach-tile');
      await tile.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('01-attachment-added');
    });

    await step(
      'arm-then-race-then-confirm',
      'Arm remove, force a mid-confirm rebuild (window focus refresh), then confirm -- single second click must delete it',
      async () => {
        const removeBtn = frame.locator('.kit-attach-remove');
        await removeBtn.waitFor({ state: 'visible', timeout: 5000 });
        await removeBtn.click(); // arm
        await page.waitForTimeout(200);
        const armedLabel = await removeBtn.textContent();
        console.log(`[v12] armed remove button label: ${JSON.stringify(armedLabel)}`);
        assert(
          /sure\?/i.test(armedLabel ?? ''),
          `expected the remove button to arm with "Sure?", got: ${armedLabel}`,
        );
        await shot('02-remove-armed');

        // Force the exact race the fix targets: an imperative rebuild
        // (chrome.js's window.addEventListener('focus', refresh)) landing
        // between the arm click and the confirm click.
        await frame.locator('body').evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForTimeout(500);
        await shot('03-after-forced-refresh-mid-confirm');

        const removeBtnAfterRebuild = frame.locator('.kit-attach-remove');
        const stillArmedLabel = await removeBtnAfterRebuild.textContent().catch(() => '');
        console.log(
          `[v12] remove button label after forced refresh (should still read "Sure?" if armed state survived the rebuild): ${JSON.stringify(stillArmedLabel)}`,
        );

        await removeBtnAfterRebuild.click(); // confirm -- must be a single click, not a re-arm
        await page.waitForTimeout(1000);
        await shot('04-after-confirm-click');

        const tileCountAfter = await frame.locator('.kit-attach-tile').count();
        console.log(
          `[v12] attachment tile count after the single confirm click post-rebuild: ${tileCountAfter}`,
        );
        assert(
          tileCountAfter === 0,
          `attachment was NOT removed by the single second click after a mid-confirm rebuild -- it likely just re-armed instead of deleting (the pre-fix race), tile count=${tileCountAfter}`,
        );
      },
    );

    // ---- Report ----
    console.log('\n================ VERIFY-12 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-12 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v12-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v12] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
