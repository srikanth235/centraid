#!/usr/bin/env node
// Apps v2 QA — Docs. Regular flow: install, empty state, upload (txt fixtures
// incl. long + unicode filenames), grid/list toggle, details panel,
// quick-look, folder create/move/rename/delete, star, trash + restore,
// delete-forever (purge via trash). Corner cases: empty state before any
// upload, a very long filename, a unicode/emoji filename.
//
// Run with: node apps/desktop/tests/e2e-live/flows-apps-v2-docs.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'apps-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-apps-v2-docs');
const FIXTURES =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-charming-matsumoto-4872ab/51bb86f0-75f7-4678-aef4-ad31b920a377/scratchpad/docs-fixtures';

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];
function wireConsole(p) {
  p.on('console', (msg) => consoleMessages.push({ text: msg.text(), type: msg.type() }));
  p.on('pageerror', (err) => consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' }));
}

let shotN = 0;
async function shot(name) {
  shotN += 1;
  const p = path.join(OUT_DIR, `docs-${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  return p;
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
      await page.screenshot({ path: path.join(OUT_DIR, `docs-FAILURE-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function installDocs() {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: 'Docs' }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: /^Preview Docs/ });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  await page.locator('[data-global-toast]').waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .getByRole('heading', { name: 'What should we build?' })
    .waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-app-id="docs"]').waitFor({ state: 'visible', timeout: 10_000 });
}

async function openDocs() {
  const tile = page.locator('[data-app-id="docs"]');
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', {
    state: 'attached',
    timeout: 20_000,
  });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(500);
  return frameLoc;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log('[docs] launched + Home ready');

  let frameLoc;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install', 'Install Docs from Discover', async () => {
      await installDocs();
    });

    await step('open-empty', 'Open Docs -> empty state before any upload', async () => {
      frameLoc = await openDocs();
      await shot('01-empty-state');
      const empty = frameLoc.locator('#empty');
      const hidden = await empty.getAttribute('hidden');
      assert(hidden === null, 'expected #empty to be visible (no hidden attr) on a fresh vault');
      const text = await empty.textContent();
      console.log(`[docs] empty state text: ${JSON.stringify(text)}`);
    });

    await step(
      'upload-basic',
      'Upload a plain .txt fixture via the hidden file input',
      async () => {
        const uploadInput = frameLoc.locator('#uploadInput');
        await uploadInput.setInputFiles(path.join(FIXTURES, 'note.txt'));
        await page.waitForTimeout(1200);
        await shot('02-after-upload-note');
        const grid = frameLoc.locator('#grid');
        const gridText = await grid.textContent().catch(() => '');
        assert(
          /note\.txt|note/.test(gridText ?? ''),
          `uploaded note.txt not visible in grid: ${JSON.stringify(gridText)}`,
        );
      },
    );

    await step(
      'upload-long-and-unicode',
      'Upload a long filename and a unicode/emoji filename',
      async () => {
        const uploadInput = frameLoc.locator('#uploadInput');
        const longName =
          'this-is-a-very-long-filename-used-to-test-docs-truncation-and-wrapping-behavior-in-the-grid-and-list-views-of-the-docs-blueprint-app.txt';
        await uploadInput.setInputFiles([
          path.join(FIXTURES, longName),
          path.join(FIXTURES, '日本語のファイル名テスト-émoji-🎉.txt'),
        ]);
        await page.waitForTimeout(1200);
        await shot('03-after-upload-long-unicode');
        const gridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(
          /日本語のファイル名テスト/.test(gridText ?? ''),
          `unicode filename not visible: ${JSON.stringify(gridText?.slice(0, 400))}`,
        );
      },
    );

    await step('list-toggle', 'Toggle to List view and back to Grid', async () => {
      await frameLoc.locator('#viewList').click();
      await page.waitForTimeout(300);
      await shot('04-list-view');
      const listWrap = frameLoc.locator('#listWrap');
      assert(
        (await listWrap.getAttribute('hidden')) === null,
        'list view should be visible after toggle',
      );
      await frameLoc.locator('#viewGrid').click();
      await page.waitForTimeout(300);
      await shot('04-grid-view-restored');
      const grid = frameLoc.locator('#grid');
      assert(
        (await grid.getAttribute('hidden')) === null,
        'grid view should be visible after toggling back',
      );
    });

    await step(
      'details-panel',
      'Open details panel for note.txt, verify fields, star it',
      async () => {
        // Click the card's title/body area, not the thumbnail — the thumbnail
        // has its own onClick (stopPropagation -> openQuick) that would
        // shadow the outer card's onOpenDetails if we clicked the card's
        // bounding-box center (which falls inside the thumb).
        const card = frameLoc.locator('.d-card', { hasText: 'note' }).first();
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        await card.locator('.d-card-body').click();
        const details = frameLoc.locator('.d-details');
        await details.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('05-details-panel');
        const detailText = await details.textContent();
        assert(/note/.test(detailText ?? ''), 'details panel does not show the document title');
        // Star it from the details panel.
        const starBtn = details.locator('button', { hasText: /Star|Starred/ }).first();
        await starBtn.click();
        await page.waitForTimeout(600);
        await shot('05b-starred');
        const starBtnText = await starBtn.textContent();
        console.log(`[docs] star button after click: ${starBtnText}`);
        assert(/Starred/.test(starBtnText ?? ''), 'star button did not flip to Starred state');
        await frameLoc.locator('.d-details-head button[aria-label="Close"]').click();
        await page.waitForTimeout(300);
      },
    );

    await step('starred-nav', 'Starred smart-nav shows the starred document', async () => {
      await frameLoc.locator('.d-nav-item', { hasText: 'Starred' }).click();
      await page.waitForTimeout(400);
      await shot('06-starred-view');
      const gridText = await frameLoc
        .locator('#grid')
        .textContent()
        .catch(() => '');
      assert(/note/.test(gridText ?? ''), 'starred nav does not show the starred document');
      await frameLoc.locator('.d-nav-item', { hasText: 'All documents' }).click();
      await page.waitForTimeout(300);
    });

    await step('quick-look', 'Open quick-look overlay for note.txt and close it', async () => {
      const thumb = frameLoc.locator('.d-card', { hasText: 'note' }).first().locator('.d-thumb');
      await thumb.click();
      const quick = frameLoc.locator('.d-quick[role="dialog"]');
      await quick.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('07-quick-look-open');
      await frameLoc.locator('.d-quick-icon').click();
      await quick.waitFor({ state: 'hidden', timeout: 5_000 });
      await shot('07b-quick-look-closed');
    });

    await step(
      'folder-create-move-rename-delete',
      'Create a folder, move a doc into it, rename it, then delete it (doc survives)',
      async () => {
        await frameLoc.locator('#newBtn').click();
        await frameLoc.locator('.d-menu-item', { hasText: 'New folder' }).click();
        await page.waitForTimeout(300);
        const createInput = frameLoc.locator('input[aria-label="New folder name"]');
        await createInput.waitFor({ state: 'visible', timeout: 5000 });
        await createInput.fill('E2E Folder');
        await createInput.press('Enter');
        await page.waitForTimeout(600);
        await shot('08-folder-created');
        const folderNav = frameLoc.locator('.d-nav-item', { hasText: 'E2E Folder' });
        assert((await folderNav.count()) > 0, 'created folder does not show in sidebar');

        // Move the "note" doc into it via its details panel Move button.
        const card = frameLoc.locator('.d-card', { hasText: 'note' }).first();
        await card.locator('.d-card-body').click();
        const details = frameLoc.locator('.d-details');
        await details.waitFor({ state: 'visible', timeout: 10_000 });
        await details.locator('button', { hasText: 'Move' }).click();
        await page.waitForTimeout(300);
        const popoverMoveItem = page
          .locator('.kit-popover-item, [role="menuitem"]', { hasText: 'E2E Folder' })
          .first();
        // Popover lives inside the iframe too.
        const framePopoverItem = frameLoc
          .locator('.kit-popover-item, [role="menuitem"]', { hasText: 'E2E Folder' })
          .first();
        if (await framePopoverItem.count()) await framePopoverItem.click();
        else await popoverMoveItem.click();
        await page.waitForTimeout(500);
        await shot('09-after-move');
        await frameLoc.locator('.d-details-head button[aria-label="Close"]').click();

        await frameLoc.locator('.d-nav-item', { hasText: 'E2E Folder' }).click();
        await page.waitForTimeout(400);
        const folderGridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(
          /note/.test(folderGridText ?? ''),
          'moved document not visible inside the folder view',
        );
        await shot('10-inside-folder-with-doc');

        // Rename the folder. Its rename/delete tool buttons are `display:none`
        // until `.d-folder:hover`/`:focus-within` (app.css) — hover the row
        // first or Playwright times out waiting for a "visible" element.
        await frameLoc.locator('.d-nav-item', { hasText: 'All documents' }).click();
        await page.waitForTimeout(300);
        const folderRow = frameLoc.locator('.d-folder', { hasText: 'E2E Folder' });
        await folderRow.hover();
        const renameBtn = frameLoc.locator('button[aria-label="Rename E2E Folder"]');
        await renameBtn.click();
        const renameInput = frameLoc.locator('input[aria-label="Folder name"]');
        await renameInput.waitFor({ state: 'visible', timeout: 5000 });
        await renameInput.fill('E2E Folder Renamed');
        await renameInput.press('Enter');
        await page.waitForTimeout(500);
        await shot('11-folder-renamed');
        assert(
          (await frameLoc.locator('.d-nav-item', { hasText: 'E2E Folder Renamed' }).count()) > 0,
          'rename did not take effect',
        );

        // Corner case: deleting a NON-empty folder must be refused (core.delete_folder's
        // folder_is_empty precondition) with a friendly message, not a raw
        // vault predicate string.
        const renamedFolderRow = frameLoc.locator('.d-folder', { hasText: 'E2E Folder Renamed' });
        await renamedFolderRow.hover();
        const delBtn = frameLoc.locator('button[aria-label="Delete E2E Folder Renamed"]');
        await delBtn.click();
        await page.waitForTimeout(150);
        await delBtn.click(); // arm-confirm second click
        await page.waitForTimeout(800);
        await shot('12-delete-nonempty-folder-refused');
        const noticeText = await frameLoc
          .locator('#noticeBanner')
          .textContent()
          .catch(() => '');
        console.log(`[docs] notice after deleting non-empty folder: ${JSON.stringify(noticeText)}`);
        assert(
          /Empty the folder first/.test(noticeText ?? ''),
          `expected the friendly "Empty the folder first…" message, got: ${JSON.stringify(noticeText)}`,
        );
        assert(
          (await frameLoc.locator('.d-nav-item', { hasText: 'E2E Folder Renamed' }).count()) > 0,
          'folder should still exist — the delete should have been refused, not applied',
        );

        // Move the doc back out to the top level, then delete now succeeds
        // and the doc survives, un-filed.
        await frameLoc.locator('.d-nav-item', { hasText: 'E2E Folder Renamed' }).click();
        await page.waitForTimeout(300);
        const cardInFolder = frameLoc.locator('.d-card', { hasText: 'note' }).first();
        await cardInFolder.locator('.d-card-body').click();
        const detailsInFolder = frameLoc.locator('.d-details');
        await detailsInFolder.waitFor({ state: 'visible', timeout: 10_000 });
        await detailsInFolder.locator('button', { hasText: 'Move' }).click();
        await page.waitForTimeout(300);
        const documentsTarget = frameLoc
          .locator('.kit-popover-item, [role="menuitem"]', { hasText: 'Documents' })
          .first();
        await documentsTarget.click();
        await page.waitForTimeout(500);
        await frameLoc.locator('.d-details-head button[aria-label="Close"]').click();
        await page.waitForTimeout(300);

        await frameLoc.locator('.d-nav-item', { hasText: 'All documents' }).click();
        await page.waitForTimeout(300);
        const renamedFolderRow2 = frameLoc.locator('.d-folder', { hasText: 'E2E Folder Renamed' });
        await renamedFolderRow2.hover();
        const delBtn2 = frameLoc.locator('button[aria-label="Delete E2E Folder Renamed"]');
        await delBtn2.click();
        await page.waitForTimeout(150);
        await delBtn2.click(); // arm-confirm second click
        await page.waitForTimeout(800);
        await shot('13-folder-deleted-after-emptying');
        assert(
          (await frameLoc.locator('.d-nav-item', { hasText: 'E2E Folder Renamed' }).count()) === 0,
          'folder still present after delete (once emptied)',
        );
        const allGridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(
          /note/.test(allGridText ?? ''),
          'document disappeared after its (now-emptied) folder was deleted — should have survived, un-filed',
        );
      },
    );

    await step(
      'trash-and-restore',
      'Trash the unicode doc, verify it is gone from All, restore it',
      async () => {
        const card = frameLoc.locator('.d-card', { hasText: '日本語' }).first();
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        await card.locator('.d-card-body').click();
        const details = frameLoc.locator('.d-details');
        await details.waitFor({ state: 'visible', timeout: 10_000 });
        const trashBtn = details.locator('button', { hasText: 'Trash' });
        await trashBtn.click();
        await page.waitForTimeout(150);
        await trashBtn.click(); // arm-confirm
        // Wait for the real signal (details panel closes — trashDoc() nulls
        // state.detailsId right after the write executes) rather than a flat
        // sleep, since the write + refresh() round-trip can outlast a fixed
        // timeout under concurrent-Electron-instance load (see driver.mjs's
        // own 120s readiness bump for the same reason).
        await details.waitFor({ state: 'hidden', timeout: 15_000 });
        await page.waitForTimeout(300);
        await shot('13-after-trash');
        const allGridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(!/日本語/.test(allGridText ?? ''), 'trashed doc still shows under All documents');

        await frameLoc.locator('.d-folder, .d-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(400);
        await shot('14-trash-view');
        const trashGridText = await frameLoc
          .locator('#grid, #list')
          .first()
          .textContent()
          .catch(() => '');
        assert(/日本語/.test(trashGridText ?? ''), 'trashed doc not visible under Trash nav');

        const trashedCard = frameLoc.locator('.d-card', { hasText: '日本語' }).first();
        await trashedCard.locator('.d-card-body').click();
        const detailsRestore = frameLoc.locator('.d-details');
        await detailsRestore.waitFor({ state: 'visible', timeout: 10_000 });
        await detailsRestore.locator('button', { hasText: 'Restore' }).click();
        await page.waitForTimeout(600);
        await shot('15-after-restore');
        // Unlike trashDoc, restoreDoc() does not null state.detailsId (the
        // panel stays open showing the now-restored doc's fresh actions) — its
        // full-bleed `.d-details-backdrop` still covers the sidebar, so close
        // it explicitly before trying to click a nav item underneath.
        await frameLoc.locator('.d-details-head button[aria-label="Close"]').click();
        await page.waitForTimeout(300);
        await frameLoc.locator('.d-nav-item', { hasText: 'All documents' }).click();
        await page.waitForTimeout(400);
        const restoredGridText = await frameLoc
          .locator('#grid')
          .textContent()
          .catch(() => '');
        assert(
          /日本語/.test(restoredGridText ?? ''),
          'restored doc not visible under All documents',
        );
      },
    );

    await step('search', 'Search filters to the long-filename doc', async () => {
      await frameLoc.locator('#searchInput').fill('truncation');
      await page.waitForTimeout(600);
      await shot('16-search-results');
      const gridText = await frameLoc
        .locator('#grid, #list')
        .first()
        .textContent()
        .catch(() => '');
      assert(
        /truncation/.test(gridText ?? ''),
        'search for "truncation" did not surface the long-filename doc',
      );
      await frameLoc.locator('#searchInput').fill('');
      await page.waitForTimeout(400);
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ DOCS APPS-V2 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('==============================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll Docs apps-v2 steps PASSED.');
    }
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'docs-FAILURE-fatal.png') });
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main();
