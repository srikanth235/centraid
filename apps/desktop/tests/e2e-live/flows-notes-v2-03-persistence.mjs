#!/usr/bin/env node
// Notes v2 QA Suite 3: persistence across a full app relaunch (same
// userDataDir -> same on-disk vault). Creates notebooks/notes/pin/attachment
// state, closes the app entirely, relaunches, and confirms everything is
// exactly as left — plus a visual check that the editor/wall render
// correctly on a "cold" reopen (no react remount weirdness).
//
// Run with: node tests/e2e-live/flows-notes-v2-03-persistence.mjs   (from apps/desktop)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'notes-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-notes-v2-03');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let shotN = 0;
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-persist-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  shotN += 1;
  const p = path.join(OUT_DIR, `persist-${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  console.log(`  shot: ${p}`);
  return p;
}

async function installNotes() {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: 'Notes' }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: /^Preview Notes/ });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  const toast = page.locator('[data-global-toast]');
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

async function openNotes() {
  const tile = page.locator('[data-app-id="notes"]');
  await tile.waitFor({ state: 'visible', timeout: 15_000 });
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 20_000,
  });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  return frameLoc;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[notes-v2-03] launched + Home ready in ${Date.now() - t0}ms`);
  let frame;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step(
      'install-and-seed-state',
      'Install Notes; create 2 notebooks, 3 notes (1 filed, 1 pinned, 1 with an attachment + checklist)',
      async () => {
        await installNotes();
        frame = await openNotes();
        await page.waitForTimeout(500);

        await frame.locator('button[aria-label="New notebook"]').click();
        await frame.locator('input[aria-label="Notebook name"]').fill('Work');
        await frame.locator('button[type="submit"]', { hasText: 'Create' }).click();
        await frame
          .locator('.nt-nb-name', { hasText: 'Work' })
          .waitFor({ state: 'visible', timeout: 5_000 });

        await frame.locator('.nt-nb-name', { hasText: 'Work' }).click();
        await page.waitForTimeout(300);
        const titleInput = frame.locator('.nt-qa-title');
        await titleInput.click();
        await titleInput.fill('Persistence probe — filed note');
        const bodyInput = frame.locator('.nt-qa-body');
        await bodyInput.fill('This note must survive a full app relaunch.');
        await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
        await frame
          .locator('.nt-card-title', { hasText: 'Persistence probe — filed note' })
          .waitFor({ state: 'visible', timeout: 10_000 });

        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(300);
        const titleInput2 = frame.locator('.nt-qa-title');
        await titleInput2.click();
        await titleInput2.fill('Persistence probe — pinned note');
        await frame
          .locator('.nt-qa-body')
          .fill('- [ ] Verify this survives relaunch\n- [x] Already checked once');
        await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
        const pinnedCard = frame.locator('.nt-card', {
          hasText: 'Persistence probe — pinned note',
        });
        await pinnedCard.waitFor({ state: 'visible', timeout: 10_000 });
        await pinnedCard.locator('.nt-pin-btn').click();
        await page.waitForTimeout(400);

        // A third note with an attachment.
        const titleInput3 = frame.locator('.nt-qa-title');
        await titleInput3.click();
        await titleInput3.fill('Persistence probe — with attachment');
        await frame.locator('.nt-qa-actions .kit-btn.primary', { hasText: 'Add note' }).click();
        const attachCard = frame.locator('.nt-card', {
          hasText: 'Persistence probe — with attachment',
        });
        await attachCard.waitFor({ state: 'visible', timeout: 10_000 });
        await attachCard.click();
        await frame.locator('.nt-editor').waitFor({ state: 'visible', timeout: 10_000 });
        const pngPath = path.join(OUT_DIR, 'persist-tiny.png');
        const pngBytes = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        );
        await fs.writeFile(pngPath, pngBytes);
        await frame.locator('.nt-attach-btn', { hasText: 'Attach a file' }).click();
        await frame.locator('#attachInput').setInputFiles(pngPath);
        await frame.locator('.kit-attach-tile').waitFor({ state: 'visible', timeout: 10_000 });
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await page.waitForTimeout(400);

        await shot('seeded-state-before-relaunch');
      },
    );

    let counts = null;
    await step(
      'capture-pre-relaunch-state',
      'Capture sidebar summary + Pinned count before closing the app',
      async () => {
        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(300);
        const summaryLine = await frame.locator('.nt-summary-line').textContent();
        const pinnedCount = await frame
          .locator('.nt-nav-item', { hasText: 'Pinned' })
          .locator('.nt-nav-count')
          .textContent();
        counts = { summaryLine, pinnedCount };
        console.log(
          `[notes-v2-03] pre-relaunch: summary="${summaryLine}", pinnedCount=${pinnedCount}`,
        );
        assert(pinnedCount === '1', `expected 1 pinned note before relaunch, got ${pinnedCount}`);
      },
    );

    await step(
      'relaunch-same-userdata',
      'Fully close and relaunch the app with the same userDataDir',
      async () => {
        await session.close();
        await new Promise((r) => setTimeout(r, 600));
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        await page.setViewportSize({ width: 1400, height: 900 });
        await shot('relaunched-home');
      },
    );

    await step(
      'reopen-and-verify-notebooks-and-notes',
      'Reopen Notes; both notebooks + all 3 notes are present with correct scope/pin/checklist state',
      async () => {
        frame = await openNotes();
        await page.waitForTimeout(600);
        await shot('reopened-notes-app');

        const workNb = frame.locator('.nt-nb-name', { hasText: 'Work' });
        await workNb.waitFor({ state: 'visible', timeout: 10_000 });

        const summaryLine = await frame.locator('.nt-summary-line').textContent();
        console.log(
          `[notes-v2-03] post-relaunch summary line: "${summaryLine}" (was "${counts?.summaryLine}" before)`,
        );
        assert(
          summaryLine === counts?.summaryLine,
          `sidebar summary changed across relaunch: "${summaryLine}" vs "${counts?.summaryLine}"`,
        );

        const pinnedCount = await frame
          .locator('.nt-nav-item', { hasText: 'Pinned' })
          .locator('.nt-nav-count')
          .textContent();
        assert(
          pinnedCount === '1',
          `expected 1 pinned note to survive relaunch, got ${pinnedCount}`,
        );

        const filedCard = frame.locator('.nt-card-title', {
          hasText: 'Persistence probe — filed note',
        });
        await filedCard.waitFor({ state: 'visible', timeout: 10_000 });
        const pinnedCard = frame.locator('.nt-card-title', {
          hasText: 'Persistence probe — pinned note',
        });
        await pinnedCard.waitFor({ state: 'visible', timeout: 10_000 });
        const attachCard = frame.locator('.nt-card-title', {
          hasText: 'Persistence probe — with attachment',
        });
        await attachCard.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('all-three-notes-present');

        // The filed note should still be scoped under "Work".
        await workNb.click();
        await page.waitForTimeout(300);
        await shot('work-notebook-after-relaunch');
        const inWork = await frame
          .locator('.nt-card-title', { hasText: 'Persistence probe — filed note' })
          .count();
        assert(
          inWork === 1,
          'the note filed into "Work" before relaunch is no longer scoped there after relaunch',
        );

        // The checklist state on the pinned note should also survive.
        await frame.locator('.nt-nav-item', { hasText: 'All notes' }).click();
        await page.waitForTimeout(300);
        await frame.locator('.nt-card', { hasText: 'Persistence probe — pinned note' }).click();
        await frame.locator('.nt-editor').waitFor({ state: 'visible', timeout: 10_000 });
        const checkedBoxes = await frame.locator('.nt-check-line.done').count();
        const totalBoxes = await frame.locator('.nt-check-line').count();
        console.log(
          `[notes-v2-03] pinned note checklist after relaunch: ${checkedBoxes}/${totalBoxes} done`,
        );
        assert(
          totalBoxes === 2 && checkedBoxes === 1,
          `checklist state did not survive relaunch: ${checkedBoxes}/${totalBoxes}`,
        );
        await shot('checklist-state-after-relaunch');
        await frame.locator('.kit-icon-btn[aria-label="Back"]').click();
        await page.waitForTimeout(300);

        // The attachment should still be there and load-bearing (not a broken img).
        await frame.locator('.nt-card', { hasText: 'Persistence probe — with attachment' }).click();
        await frame.locator('.nt-editor').waitFor({ state: 'visible', timeout: 10_000 });
        const tile = frame.locator('.kit-attach-tile');
        await tile.waitFor({ state: 'visible', timeout: 10_000 });
        const img = tile.locator('img');
        const naturalWidth = await img.evaluate((el) => el.naturalWidth).catch(() => 0);
        console.log(`[notes-v2-03] attachment <img> naturalWidth after relaunch: ${naturalWidth}`);
        await shot('attachment-after-relaunch');
        assert(
          naturalWidth > 0,
          'the attachment image failed to load after relaunch (broken image / lost blob)',
        );
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ NOTES V2 PERSISTENCE VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(40)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('======================================================================');
    console.log(`Console errors observed: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text} (${e.frameUrl})`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll notes-v2-03 persistence steps PASSED.');
    }
  } catch (err) {
    console.error('[notes-v2-03] FATAL:', err);
    await page
      .screenshot({ path: path.join(OUT_DIR, 'FATAL-persist-FAILURE.png') })
      .catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
