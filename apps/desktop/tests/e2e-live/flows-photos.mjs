#!/usr/bin/env node
// Photos blueprint app end-to-end flows against the REAL desktop shell — see
// apps/desktop/tests/e2e-live/README.md for the rig. Own userData dir (does
// NOT collide with sibling agents testing shell/docs concurrently). Run with:
//   node apps/desktop/tests/e2e-live/flows-photos.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'photos');
// Fixed (not tmp-random) so a second script can reuse it for the full-restart
// persistence check.
const USER_DATA_DIR =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-blueprint-design-system-04c2f0/a2c18b64-1753-471c-9557-d71e4278c8cc/scratchpad/userdata/photos-e2e';
const FIXTURES_DIR =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-blueprint-design-system-04c2f0/a2c18b64-1753-471c-9557-d71e4278c8cc/scratchpad/photos-fixtures';

const results = []; // { flow, verdict, note }
function record(flow, verdict, note) {
  results.push({ flow, verdict, note });
  console.log(`[flow] ${flow}: ${verdict}${note ? ' — ' + note : ''}`);
}

const consoleLog = [];

async function shot(page, name) {
  const p = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: p });
  console.log(`[shot] ${p}`);
  return p;
}

async function askOverlayDisplay(frameLoc) {
  return frameLoc.locator('#kitAskOverlay').evaluate((el) => getComputedStyle(el).display);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.mkdir(path.dirname(USER_DATA_DIR), { recursive: true });
  const t0 = Date.now();
  const { page, userDataDir, close } = await launchApp({ userDataDir: USER_DATA_DIR });
  console.log(
    `[flows-photos] launched + Home ready in ${Date.now() - t0}ms (userData=${userDataDir})`,
  );

  page.on('console', (msg) => {
    consoleLog.push({ text: msg.text(), type: msg.type(), frameUrl: msg.location()?.url ?? '' });
  });
  page.on('pageerror', (err) => {
    consoleLog.push({ text: `[pageerror] ${err.message}`, type: 'error', frameUrl: '' });
  });

  await page.setViewportSize({ width: 1400, height: 900 });

  try {
    // ---------- SETUP: Discover -> install Photos template -> open it ----------
    await navTo(page, 'Discover');
    const photosCard = page.locator('button[data-kind="app"]', { hasText: 'Photos' });
    await photosCard.first().waitFor({ state: 'visible', timeout: 20_000 });
    await photosCard.first().click();
    const dialog = page.getByRole('dialog', { name: /^Preview Photos/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    console.log('[setup] installed Photos from its template');

    const tile = page.locator('[data-app-id="photos"]');
    await tile.waitFor({ state: 'visible', timeout: 20_000 });
    await tile.getByTestId('app-tile').click();
    console.log('[setup] opened the Photos app tile');

    await page.waitForSelector('iframe[data-centraid-app="1"]', {
      state: 'attached',
      timeout: 30_000,
    });
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    console.log('[setup] app iframe attached');

    // ================= FLOW 1: Ask panel =================
    try {
      await frameLoc.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(300); // let any async boot settle
      const shot1 = await shot(page, '01-fresh-open');
      const dispClosed = await askOverlayDisplay(frameLoc);
      if (dispClosed !== 'none') {
        record(
          '1-ask-panel',
          'fail-escalated',
          `#kitAskOverlay computed display="${dispClosed}" on fresh open (expected none); screenshot ${shot1}`,
        );
      } else {
        // Ask button visible
        const askBtn = frameLoc.locator('#kitAskBtn');
        await askBtn.waitFor({ state: 'visible', timeout: 5000 });
        await askBtn.click();
        const ov = frameLoc.locator('#kitAskOverlay');
        await page.waitForTimeout(150);
        const dispOpen = await askOverlayDisplay(frameLoc);
        await shot(page, '02-ask-open');
        if (dispOpen === 'none') throw new Error('Ask overlay did not open on button click');
        // close via X
        await frameLoc.locator('.kit-ask-x').click();
        await page.waitForTimeout(150);
        const dispAfterX = await askOverlayDisplay(frameLoc);
        if (dispAfterX !== 'none') throw new Error('X did not close the ask overlay');
        // reopen, Esc close
        await askBtn.click();
        await page.waitForTimeout(150);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(150);
        const dispAfterEsc = await askOverlayDisplay(frameLoc);
        if (dispAfterEsc !== 'none') throw new Error('Esc did not close the ask overlay');
        // reopen, backdrop click close
        await askBtn.click();
        await page.waitForTimeout(150);
        // click near top-left of the overlay backdrop (outside the panel)
        const ovBox = await ov.boundingBox();
        if (ovBox) await page.mouse.click(ovBox.x + 10, ovBox.y + 10);
        await page.waitForTimeout(150);
        const dispAfterBackdrop = await askOverlayDisplay(frameLoc);
        if (dispAfterBackdrop !== 'none')
          throw new Error('Backdrop click did not close the ask overlay');
        // reopen, type + send
        await askBtn.click();
        await page.waitForTimeout(150);
        const input = frameLoc.locator('.kit-ask-compose input');
        await input.fill('Find beach photos');
        await shot(page, '03-ask-typed');
        await frameLoc.locator('.kit-ask-send').click();
        await page.waitForTimeout(4000); // let the real _turn SSE respond
        await shot(page, '04-ask-after-send');
        const bubbles = await frameLoc.locator('.kit-msg').allTextContents();
        console.log(`[flow1] ask bubbles after send: ${JSON.stringify(bubbles)}`);
        // close and re-verify no wedge
        await frameLoc.locator('.kit-ask-x').click();
        await page.waitForTimeout(150);
        const dispFinal = await askOverlayDisplay(frameLoc);
        if (dispFinal !== 'none') throw new Error('Ask overlay wedged open after send+close');
        record(
          '1-ask-panel',
          'pass',
          `closed on fresh open; open/close/X/Esc/backdrop all verified; send produced bubbles=${JSON.stringify(bubbles).slice(0, 300)}`,
        );
      }
    } catch (err) {
      await shot(page, '01x-ask-FAILURE');
      record('1-ask-panel', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 2: empty state =================
    try {
      const empty = frameLoc.locator('#empty');
      await empty.waitFor({ state: 'visible', timeout: 10_000 });
      const emptyText = await frameLoc.locator('#emptyText').textContent();
      const uploadVisible = await frameLoc.locator('#emptyUpload').isVisible();
      const footnote = await frameLoc.locator('.footnote').textContent();
      await shot(page, '05-empty-state');
      const errsSoFar = consoleLog.filter((c) => c.type === 'error');
      record(
        '2-empty-state',
        emptyText?.includes('No photos yet') && uploadVisible ? 'pass' : 'fail-escalated',
        `emptyText=${JSON.stringify(emptyText)} uploadVisible=${uploadVisible} footnote=${JSON.stringify(footnote)} consoleErrorsSoFar=${errsSoFar.length}`,
      );
    } catch (err) {
      await shot(page, '05x-empty-FAILURE');
      record('2-empty-state', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 3: real upload =================
    let uploadedNames = [];
    try {
      const files = (await fs.readdir(FIXTURES_DIR)).filter((f) => f.endsWith('.png')).sort();
      uploadedNames = files;
      const paths = files.map((f) => path.join(FIXTURES_DIR, f));
      const fileInput = frameLoc.locator('#fileInput');
      await fileInput.setInputFiles(paths);
      // wait for toast / grid tiles
      await frameLoc.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(500);
      const tileCount = await frameLoc.locator('.tile-wrap').count();
      await shot(page, '06-after-upload');
      const monthLabel = await frameLoc
        .locator('.month-label')
        .first()
        .textContent()
        .catch(() => null);
      const dayLabel = await frameLoc
        .locator('.day-label')
        .first()
        .textContent()
        .catch(() => null);
      record(
        '3-real-upload',
        tileCount === files.length ? 'pass' : 'fail-escalated',
        `expected ${files.length} tiles, got ${tileCount}; month=${JSON.stringify(monthLabel)} day=${JSON.stringify(dayLabel)}`,
      );
    } catch (err) {
      await shot(page, '06x-upload-FAILURE');
      record('3-real-upload', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 4a: persistence (reopen within session) =================
    try {
      await navTo(page, 'Home');
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 10_000 });
      const tileHome = page.locator('[data-app-id="photos"]');
      await tileHome.waitFor({ state: 'visible', timeout: 10_000 });
      await tileHome.getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
      const frameLoc2 = page.frameLocator('iframe[data-centraid-app="1"]');
      await frameLoc2.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 15_000 });
      const count2 = await frameLoc2.locator('.tile-wrap').count();
      await shot(page, '07-reopen-same-session');
      record(
        '4a-persistence-reopen',
        count2 === uploadedNames.length ? 'pass' : 'fail-escalated',
        `tiles after reopen = ${count2}`,
      );
    } catch (err) {
      await shot(page, '07x-reopen-FAILURE');
      record('4a-persistence-reopen', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 5: core journeys (select/favorite/albums) =================
    let frameLoc3 = page.frameLocator('iframe[data-centraid-app="1"]');
    try {
      // select mode
      await frameLoc3.locator('#selectBtn').click();
      const tiles = frameLoc3.locator('.tile-wrap');
      const n = await tiles.count();
      // select first 2 tiles via their tile-check button
      for (let i = 0; i < Math.min(2, n); i++) {
        await tiles.nth(i).locator('.tile-check').click();
      }
      const bar = frameLoc3.locator('#selectionBar');
      await bar.waitFor({ state: 'visible', timeout: 5000 });
      const barCount = await bar.locator('.bar-count').textContent();
      await shot(page, '08-selection-bar');

      // bulk favorite via hearts directly on each selected tile instead (bar has no favorite action;
      // use per-tile heart button for the 2 selected tiles)
      for (let i = 0; i < Math.min(2, n); i++) {
        await tiles.nth(i).locator('.tile-heart').click();
        await page.waitForTimeout(150);
      }
      const favedCount = await frameLoc3.locator('.tile-wrap.faved').count();
      await shot(page, '09-hearts-set');

      // exit select mode
      await frameLoc3.locator('.bar-close').click();
      record(
        '5a-select-and-favorite',
        favedCount >= 1 && barCount?.includes('selected') ? 'pass' : 'fail-escalated',
        `barCount=${JSON.stringify(barCount)} favedCount=${favedCount}`,
      );
    } catch (err) {
      await shot(page, '08x-select-FAILURE');
      record('5a-select-and-favorite', 'fail-escalated', String(err?.message ?? err));
    }

    // hearts persist across reopen
    try {
      await navTo(page, 'Home');
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 10_000 });
      const tileHome = page.locator('[data-app-id="photos"]');
      await tileHome.getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
      frameLoc3 = page.frameLocator('iframe[data-centraid-app="1"]');
      await frameLoc3.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 15_000 });
      const favedAfter = await frameLoc3.locator('.tile-wrap.faved').count();
      record(
        '5b-hearts-persist',
        favedAfter >= 1 ? 'pass' : 'fail-escalated',
        `favedAfter=${favedAfter}`,
      );
    } catch (err) {
      record('5b-hearts-persist', 'fail-escalated', String(err?.message ?? err));
    }

    // album create + add via bar menu popover + chip count + filter switch + rename + remove + delete
    try {
      await frameLoc3.locator('.chip-new').click();
      const inlineInput = frameLoc3.locator('.chip-input');
      await inlineInput.waitFor({ state: 'visible', timeout: 5000 });
      await inlineInput.fill('Test Album');
      await inlineInput.press('Enter');
      await page.waitForTimeout(400);
      const chip = frameLoc3.locator('.kit-chip', { hasText: 'Test Album' });
      await chip.waitFor({ state: 'visible', timeout: 5000 });
      await shot(page, '10-album-created');

      // select 2 tiles (on All), open bar menu, add to album
      await frameLoc3.locator('.kit-chip', { hasText: 'All' }).click();
      await frameLoc3.locator('#selectBtn').click();
      const tilesAll = frameLoc3.locator('.tile-wrap');
      await tilesAll.nth(0).locator('.tile-check').click();
      await tilesAll.nth(1).locator('.tile-check').click();
      const barBtn = frameLoc3.locator('.bar-btn', { hasText: 'Add to album' });
      await barBtn.click();
      const menu = frameLoc3.locator('.album-menu');
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      const menuBox = await menu.boundingBox();
      const btnBox = await barBtn.boundingBox();
      await shot(page, '11-album-menu-open');
      const anchored =
        menuBox && btnBox ? Math.abs(menuBox.y - (btnBox.y + btnBox.height)) < 200 : false;
      await frameLoc3.locator('.album-menu-item', { hasText: 'Test Album' }).click();
      await page.waitForTimeout(400);
      await frameLoc3.locator('.bar-close').click();

      // chip count reflects
      const chipAfter = frameLoc3.locator('.kit-chip', { hasText: 'Test Album' });
      const chipText = await chipAfter.textContent();

      // switch to the album filter
      await chipAfter.click();
      await page.waitForTimeout(300);
      const gridCountInAlbum = await frameLoc3.locator('.tile-wrap').count();
      await shot(page, '12-album-filter');

      // rename
      await frameLoc3.locator('.kit-btn', { hasText: 'Rename' }).click();
      const renameInput = frameLoc3.locator('.album-tools input');
      await renameInput.waitFor({ state: 'visible', timeout: 5000 });
      await renameInput.fill('Renamed Album');
      await renameInput.press('Enter');
      await page.waitForTimeout(400);
      const renamedChip = frameLoc3.locator('.kit-chip', { hasText: 'Renamed Album' });
      const renamedVisible = await renamedChip.isVisible().catch(() => false);
      await shot(page, '13-album-renamed');

      // remove-from-album (one tile's × button)
      const beforeRemoveCount = await frameLoc3.locator('.tile-wrap').count();
      await frameLoc3.locator('.tile-wrap').first().locator('.tile-remove').click();
      await page.waitForTimeout(400);
      const afterRemoveCount = await frameLoc3.locator('.tile-wrap').count();

      // delete album — two-step confirm (armConfirm pattern: click once arms, click again confirms)
      const deleteBtn = frameLoc3.locator('.kit-btn.danger', { hasText: 'Delete album' });
      await deleteBtn.click();
      await page.waitForTimeout(200);
      const armedText = await deleteBtn.textContent();
      await shot(page, '14-album-delete-armed');
      await deleteBtn.click();
      await page.waitForTimeout(400);
      const chipGone = await frameLoc3.locator('.kit-chip', { hasText: 'Renamed Album' }).count();
      await shot(page, '15-album-deleted');

      record(
        '5c-albums',
        anchored && renamedVisible && afterRemoveCount === beforeRemoveCount - 1 && chipGone === 0
          ? 'pass'
          : 'fail-escalated',
        `menuAnchored=${anchored} chipTextAfterAdd=${JSON.stringify(chipText)} inAlbumCount=${gridCountInAlbum} renamedVisible=${renamedVisible} armedText=${JSON.stringify(armedText)} removeFrom:${beforeRemoveCount}->${afterRemoveCount} chipGoneAfterDelete=${chipGone === 0}`,
      );
    } catch (err) {
      await shot(page, '10x-albums-FAILURE');
      record('5c-albums', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 6: lightbox =================
    try {
      await frameLoc3.locator('.kit-chip', { hasText: 'All' }).click();
      await page.waitForTimeout(300);
      const tilesForLightbox = frameLoc3.locator('.tile-wrap');
      const total = await tilesForLightbox.count();
      await tilesForLightbox.nth(1).locator('.tile').click(); // middle-ish tile so both arrows may be enabled
      const lightbox = frameLoc3.locator('#lightbox');
      await lightbox.waitFor({ state: 'visible', timeout: 10_000 });
      await shot(page, '16-lightbox-open');

      const prevBtn = frameLoc3.locator('.kit-viewer-nav.prev');
      const nextBtn = frameLoc3.locator('.kit-viewer-nav.next');
      const prevDisabledBefore = await prevBtn.isDisabled();
      await nextBtn.click();
      await page.waitForTimeout(200);
      await shot(page, '17-lightbox-next');
      await prevBtn.click();
      await page.waitForTimeout(200);

      // favorite toggle from lightbox
      const favBtn = frameLoc3.locator('.lightbox-fav');
      const favBefore = await favBtn.getAttribute('aria-pressed');
      await favBtn.click();
      await page.waitForTimeout(200);
      const favAfter = await favBtn.getAttribute('aria-pressed');

      // caption edit
      const captionInput = frameLoc3.locator('.lightbox-title');
      await captionInput.fill('My test caption');
      await captionInput.press('Tab');
      await page.waitForTimeout(400);

      // capture-time edit
      const whenInput = frameLoc3.locator('.lightbox-when');
      await whenInput.fill('2026-01-15T10:30');
      await whenInput.press('Tab');
      await page.waitForTimeout(400);
      await shot(page, '18-lightbox-edited');

      // clicking arrows/caption/favorite must NOT close it (already exercised above — still open?)
      const stillOpenAfterEdits = await lightbox.isVisible();

      // zoom via wheel/dblclick best-effort
      const stageImg = frameLoc3.locator('.lightbox-stage img').first();
      await stageImg.dblclick().catch(() => {});
      await page.waitForTimeout(200);
      const zoomedClass = await stageImg.getAttribute('class').catch(() => '');
      await shot(page, '19-lightbox-zoom-attempt');
      await stageImg.dblclick().catch(() => {}); // unzoom

      // Esc closes
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      const closedByEsc = !(await lightbox.isVisible());

      // reopen, verify caption persisted, then backdrop click closes, then delete-from-lightbox
      await tilesForLightbox.nth(1).locator('.tile').click();
      await lightbox.waitFor({ state: 'visible', timeout: 10_000 });
      const captionPersisted = await frameLoc3.locator('.lightbox-title').inputValue();
      const box = await lightbox.boundingBox();
      if (box) await page.mouse.click(box.x + 5, box.y + 5); // backdrop corner
      await page.waitForTimeout(200);
      const closedByBackdrop = !(await lightbox.isVisible());

      record(
        '6-lightbox',
        prevDisabledBefore === true &&
          favBefore !== favAfter &&
          stillOpenAfterEdits &&
          closedByEsc &&
          captionPersisted === 'My test caption' &&
          closedByBackdrop
          ? 'pass'
          : 'fail-escalated',
        `prevDisabledAtStart=${prevDisabledBefore} fav:${favBefore}->${favAfter} stillOpenAfterEdits=${stillOpenAfterEdits} closedByEsc=${closedByEsc} captionPersisted=${JSON.stringify(captionPersisted)} zoomedClass=${JSON.stringify(zoomedClass)} closedByBackdrop=${closedByBackdrop}`,
      );
    } catch (err) {
      await shot(page, '16x-lightbox-FAILURE');
      record('6-lightbox', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 7: trash =================
    try {
      const tilesForTrash = frameLoc3.locator('.tile-wrap');
      const before = await tilesForTrash.count();
      // delete 2 via select mode + bulk delete bar button (arm+confirm)
      await frameLoc3.locator('#selectBtn').click();
      await tilesForTrash.nth(0).locator('.tile-check').click();
      await tilesForTrash.nth(1).locator('.tile-check').click();
      const delBtn = frameLoc3.locator('.bar-btn.danger', { hasText: 'Delete' });
      await delBtn.click(); // arm
      await page.waitForTimeout(150);
      await delBtn.click(); // confirm
      await page.waitForTimeout(600);
      const afterDeleteCount = await frameLoc3.locator('.tile-wrap').count();
      await shot(page, '20-after-trash-delete');

      const trashChip = frameLoc3.locator('.kit-chip.chip-trash');
      await trashChip.waitFor({ state: 'visible', timeout: 5000 });
      const trashChipText = await trashChip.textContent();
      await trashChip.click();
      await page.waitForTimeout(300);
      const trashTiles = frameLoc3.locator('.tile-wrap.trash');
      const trashCount = await trashTiles.count();
      const purgeLabel = await trashTiles
        .first()
        .locator('.tile-purge')
        .textContent()
        .catch(() => null);
      await shot(page, '21-trash-view');

      // favorites count excludes trashed
      const favCountChip = frameLoc3.locator('.kit-chip', { hasText: 'Favorites' });
      await favCountChip.click();
      await page.waitForTimeout(300);
      const favVisibleCount = await frameLoc3.locator('.tile-wrap').count();
      await shot(page, '22-favorites-after-trash');

      // restore
      await trashChip.click();
      await page.waitForTimeout(300);
      await frameLoc3.locator('.tile-restore').first().click();
      await page.waitForTimeout(600);
      const trashCountAfterRestore = await frameLoc3.locator('.tile-wrap.trash').count();
      await shot(page, '23-after-restore');

      record(
        '7-trash',
        afterDeleteCount === before - 2 &&
          trashCount >= 2 &&
          trashCountAfterRestore === trashCount - 1
          ? 'pass'
          : 'fail-escalated',
        `before=${before} afterDelete=${afterDeleteCount} trashChipText=${JSON.stringify(trashChipText)} trashCount=${trashCount} purgeLabel=${JSON.stringify(purgeLabel)} favVisibleCount=${favVisibleCount} trashAfterRestore=${trashCountAfterRestore}`,
      );
    } catch (err) {
      await shot(page, '20x-trash-FAILURE');
      record('7-trash', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 8: faces (fresh vault, no enrichment) =================
    try {
      await frameLoc3.locator('.kit-chip', { hasText: 'All' }).click();
      await page.waitForTimeout(300);
      await frameLoc3.locator('.tile-wrap').first().locator('.tile').click();
      const lightbox2 = frameLoc3.locator('#lightbox');
      await lightbox2.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(500); // renderFaces is async
      const facesTitleCount = await frameLoc3.locator('.lightbox-faces-title').count();
      const facesHostHtml = await frameLoc3.locator('.lightbox-faces').innerHTML();
      await shot(page, '24-lightbox-no-faces');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(150);
      const errsNow = consoleLog.filter((c) => c.type === 'error');
      record(
        '8-faces',
        facesTitleCount === 0 ? 'pass' : 'fail-escalated',
        `People heading present=${facesTitleCount > 0} (expected absent); facesHostHtml=${JSON.stringify(facesHostHtml)}; consoleErrorsSoFar=${errsNow.length}`,
      );
    } catch (err) {
      await shot(page, '24x-faces-FAILURE');
      record('8-faces', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 9: search =================
    try {
      const search = frameLoc3.locator('#searchInput');
      await search.fill('purple');
      await page.waitForTimeout(300);
      const filteredCount = await frameLoc3.locator('.tile-wrap').count();
      const clearBtn = frameLoc3.locator('#searchClear');
      const clearVisible = await clearBtn.isVisible();
      await shot(page, '25-search-filtered');
      await clearBtn.click();
      await page.waitForTimeout(300);
      const afterClearCount = await frameLoc3.locator('.tile-wrap').count();
      const focusRing = await search.evaluate((el) => {
        el.focus();
        return getComputedStyle(el.closest('.kit-search') || el).boxShadow;
      });
      record(
        '9-search',
        clearVisible && afterClearCount > filteredCount ? 'pass' : 'fail-escalated',
        `filteredCount=${filteredCount} clearVisible=${clearVisible} afterClearCount=${afterClearCount} focusRingBoxShadow=${JSON.stringify(focusRing)}`,
      );
    } catch (err) {
      await shot(page, '25x-search-FAILURE');
      record('9-search', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 10: dark mode + theme bridge =================
    try {
      await shot(page, '26-light-before-dark');
      await navTo(page, 'Settings');
      const darkCard = page.locator('.themeCard[data-name="dark"], [data-name="dark"]');
      await darkCard.waitFor({ state: 'visible', timeout: 10_000 });
      await darkCard.click();
      await page.waitForTimeout(500);
      await navTo(page, 'Home');
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 10_000 });
      const tileHome2 = page.locator('[data-app-id="photos"]');
      await tileHome2.getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
      const frameLocDark = page.frameLocator('iframe[data-centraid-app="1"]');
      await frameLocDark.locator('h1').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(500);
      const dataTheme = await frameLocDark.locator('html').evaluate((el) => el.dataset.theme);
      const bg = await frameLocDark
        .locator('body')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      await shot(page, '27-dark-mode');
      record(
        '10-dark-theme-bridge',
        dataTheme === 'dark' ? 'pass' : 'fail-escalated',
        `iframe html[data-theme]=${JSON.stringify(dataTheme)} bodyBg=${JSON.stringify(bg)}`,
      );
      // revert to light for cleanliness of subsequent screenshots
      await navTo(page, 'Settings');
      const lightCard = page.locator('[data-name="light"]');
      await lightCard.waitFor({ state: 'visible', timeout: 10_000 });
      await lightCard.click();
      await page.waitForTimeout(400);
      await navTo(page, 'Home');
      await page
        .getByRole('heading', { name: 'What should we build?' })
        .waitFor({ state: 'visible', timeout: 10_000 });
      await page.locator('[data-app-id="photos"]').getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
    } catch (err) {
      await shot(page, '26x-dark-FAILURE');
      record('10-dark-theme-bridge', 'fail-escalated', String(err?.message ?? err));
    }

    // ================= FLOW 11: narrow layout =================
    try {
      await page.setViewportSize({ width: 500, height: 800 });
      await page.waitForTimeout(400);
      const frameLocNarrow = page.frameLocator('iframe[data-centraid-app="1"]');
      await frameLocNarrow
        .locator('.tile-wrap')
        .first()
        .waitFor({ state: 'visible', timeout: 10_000 });
      await shot(page, '28-narrow-grid');
      const scrollInfo = await frameLocNarrow.locator('body').evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      // open lightbox narrow
      await frameLocNarrow.locator('.tile-wrap').first().locator('.tile').click();
      await frameLocNarrow.locator('#lightbox').waitFor({ state: 'visible', timeout: 10_000 });
      await shot(page, '29-narrow-lightbox');
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 1400, height: 900 });
      record(
        '11-narrow',
        scrollInfo.scrollWidth <= scrollInfo.clientWidth + 2 ? 'pass' : 'fail-escalated',
        `scrollWidth=${scrollInfo.scrollWidth} clientWidth=${scrollInfo.clientWidth}`,
      );
    } catch (err) {
      await shot(page, '28x-narrow-FAILURE');
      record('11-narrow', 'fail-escalated', String(err?.message ?? err));
      await page.setViewportSize({ width: 1400, height: 900 }).catch(() => undefined);
    }

    // ================= FLOW 12: consent seam (documented at empty-state time) =================
    // Recorded from flow 2 + setup observations — see final report notes.

    // final ask-panel smoke re-check
    try {
      const frameLocFinal = page.frameLocator('iframe[data-centraid-app="1"]');
      const dispFinal = await askOverlayDisplay(frameLocFinal);
      record(
        '1-ask-panel-final-smoke',
        dispFinal === 'none' ? 'pass' : 'fail-escalated',
        `display=${dispFinal}`,
      );
    } catch (err) {
      record('1-ask-panel-final-smoke', 'fail-escalated', String(err?.message ?? err));
    }

    console.log(`[flows-photos] all flows attempted in ${Date.now() - t0}ms total`);
  } catch (err) {
    await shot(page, 'FATAL-FAILURE');
    console.error('[flows-photos] FATAL', err);
  } finally {
    const errCount = consoleLog.filter((c) => c.type === 'error').length;
    const warnCount = consoleLog.filter((c) => c.type === 'warning').length;
    console.log(
      `\n[console-summary] total=${consoleLog.length} error=${errCount} warning=${warnCount}`,
    );
    for (const c of consoleLog.filter((c) => c.type === 'error' || c.type === 'warning')) {
      console.log(`  [${c.type}] ${c.text} (${c.frameUrl})`);
    }
    console.log('\n[verdict-table]');
    for (const r of results)
      console.log(`  ${r.flow}: ${r.verdict}${r.note ? ' — ' + r.note : ''}`);
    await close();
    console.log(
      `\n[flows-photos] userDataDir kept at ${USER_DATA_DIR} for restart-persistence check`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
