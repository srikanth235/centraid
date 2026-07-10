#!/usr/bin/env node
// Photos e2e phase 2: full-restart persistence (reuses phase 1's userData dir),
// verification of the createImageBitmap thumb fix, and re-runs of the flows
// phase 1 failed on for test-script reasons (hover-gated hearts, selection-bar
// auto-exit, lightbox reordering, Settings accessible name "Settings live").
// Run: node apps/desktop/tests/e2e-live/flows-photos-2.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'photos');
const USER_DATA_DIR =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-blueprint-design-system-04c2f0/a2c18b64-1753-471c-9557-d71e4278c8cc/scratchpad/userdata/photos-e2e';
const FIXTURES_DIR =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-blueprint-design-system-04c2f0/a2c18b64-1753-471c-9557-d71e4278c8cc/scratchpad/photos-fixtures';

const results = [];
function record(flow, verdict, note) {
  results.push({ flow, verdict, note });
  console.log(`[flow] ${flow}: ${verdict}${note ? ' — ' + note : ''}`);
}
const consoleLog = [];
async function shot(page, name) {
  const p = path.join(OUT_DIR, `${name}.png`);
  await page.screenshot({ path: p });
  console.log(`[shot] ${p}`);
}

async function openPhotos(page) {
  await page.getByRole('button', { name: /^Home/ }).first().click();
  await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 15_000 });
  const tile = page.locator('[data-app-id="photos"]');
  await tile.waitFor({ state: 'visible', timeout: 15_000 });
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
  return frameLoc;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const { page, close } = await launchApp({ userDataDir: USER_DATA_DIR });
  console.log(`[phase2] RESTARTED app with reused userData in ${Date.now() - t0}ms`);
  page.on('console', (msg) => consoleLog.push({ text: msg.text(), type: msg.type(), frameUrl: msg.location()?.url ?? '' }));
  page.on('pageerror', (err) => consoleLog.push({ text: `[pageerror] ${err.message}`, type: 'error', frameUrl: '' }));
  await page.setViewportSize({ width: 1400, height: 900 });

  try {
    // ---------- FLOW 4b: full-restart persistence ----------
    let frameLoc;
    try {
      frameLoc = await openPhotos(page);
      await frameLoc.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(600);
      const liveTiles = await frameLoc.locator('.tile-wrap').count();
      const chips = await frameLoc.locator('#albumChips .kit-chip').allTextContents();
      const monthLabels = await frameLoc.locator('.month-label').allTextContents();
      const favedCount = await frameLoc.locator('.tile-wrap.faved').count();
      await shot(page, '30-after-full-restart');
      // Phase 1 left: 5 live (6 - 2 deleted + 1 restored), Test Album, Trash(1),
      // 1 lightbox-favorited asset, one asset re-dated to Jan 2026.
      const ok = liveTiles === 5 && chips.some((c) => c.includes('Test Album')) && chips.some((c) => c.includes('Trash (1)'));
      record('4b-restart-persistence', ok ? 'pass' : 'fail-escalated',
        `liveTiles=${liveTiles} chips=${JSON.stringify(chips)} months=${JSON.stringify(monthLabels)} faved=${favedCount}`);
    } catch (err) {
      await shot(page, '30x-restart-FAILURE');
      record('4b-restart-persistence', 'fail-escalated', String(err?.message ?? err));
      throw err;
    }

    // capture-time edit persistence: an asset re-dated to Jan 2026 must render
    // under a "January 2026" month header after a full restart.
    try {
      const monthLabels = await frameLoc.locator('.month-label').allTextContents();
      const hasJan = monthLabels.some((m) => /January 2026/.test(m));
      // caption persistence: find the asset under the January header and check its caption
      let caption = null;
      if (hasJan) {
        // last tile-wrap is the oldest (Jan 2026 sorts after July) — open it
        const lastTile = frameLoc.locator('.tile-wrap').last();
        const assetId = await lastTile.getAttribute('data-asset-id');
        await lastTile.locator('.tile').click();
        await frameLoc.locator('#lightbox').waitFor({ state: 'visible', timeout: 10_000 });
        caption = await frameLoc.locator('.lightbox-title').inputValue();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        console.log(`[6-persist] jan asset=${assetId} caption=${JSON.stringify(caption)}`);
      }
      record('6b-lightbox-edits-persist-restart',
        hasJan && caption === 'My test caption' ? 'pass' : 'fail-escalated',
        `januaryHeaderPresent=${hasJan} captionOnJanAsset=${JSON.stringify(caption)} months=${JSON.stringify(monthLabels)}`);
    } catch (err) {
      record('6b-lightbox-edits-persist-restart', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 3b: upload with the CSP fix (createImageBitmap) ----------
    try {
      const before = await frameLoc.locator('.tile-wrap').count();
      const errBefore = consoleLog.filter((c) => c.type === 'error').length;
      await frameLoc.locator('#fileInput').setInputFiles([
        path.join(FIXTURES_DIR, 'teal-800.png'),
        path.join(FIXTURES_DIR, 'magenta-800.png'),
      ]);
      await page.waitForFunction(
        (want) => {
          const f = document.querySelector('iframe[data-centraid-app="1"]');
          return f?.contentDocument?.querySelectorAll('.tile-wrap').length === want;
        },
        before + 2,
        { timeout: 20_000 },
      ).catch(() => {});
      await page.waitForTimeout(800);
      const after = await frameLoc.locator('.tile-wrap').count();
      const blobErrs = consoleLog.filter((c) => c.type === 'error' && c.text.includes('blob:'));
      const errAfter = consoleLog.filter((c) => c.type === 'error');
      const newErrs = errAfter.slice(errBefore).map((e) => e.text.slice(0, 120));
      // Verify the thumb VARIANT actually staged and serves 200 for a new tile:
      const thumbProbe = await frameLoc.locator('.tile-wrap').first().evaluate(async (el) => {
        const img = el.querySelector('img');
        if (!img) return { hasImg: false };
        const src = img.currentSrc || img.src;
        const r = await fetch(src);
        return { hasImg: true, src: src.slice(src.indexOf('/centraid')), status: r.status, isThumbVariant: src.includes('variant=thumb'), naturalWidth: img.naturalWidth };
      });
      await shot(page, '31-upload-big-after-fix');
      record('3b-upload-thumb-fix',
        after === before + 2 && blobErrs.length === 0 && thumbProbe.status === 200 && thumbProbe.isThumbVariant
          ? 'pass-after-fix'
          : 'fail-escalated',
        `tiles ${before}->${after}; blobCspErrors=${blobErrs.length}; thumbProbe=${JSON.stringify(thumbProbe)}; newConsoleErrors=${JSON.stringify(newErrs)}`);
    } catch (err) {
      await shot(page, '31x-upload-fix-FAILURE');
      record('3b-upload-thumb-fix', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 5a/5b: favorites via hover-revealed hearts ----------
    try {
      const target = frameLoc.locator('.tile-wrap').first();
      const assetId = await target.getAttribute('data-asset-id');
      const favedBefore = await frameLoc.locator('.tile-wrap.faved').count();
      await target.hover();
      await page.waitForTimeout(200);
      await target.locator('.tile-heart').click();
      await page.waitForTimeout(500);
      const nowFaved = await frameLoc.locator(`.tile-wrap[data-asset-id="${assetId}"].faved`).count();
      await shot(page, '32-heart-set');
      // reopen app view (close + reopen) and check persistence
      frameLoc = await openPhotos(page);
      await frameLoc.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(500);
      const stillFaved = await frameLoc.locator(`.tile-wrap[data-asset-id="${assetId}"].faved`).count();
      const favedTotal = await frameLoc.locator('.tile-wrap.faved').count();
      record('5ab-favorite-and-persist', nowFaved === 1 && stillFaved === 1 ? 'pass' : 'fail-escalated',
        `asset=${assetId} favedBefore(all)=${favedBefore} favedNow=${nowFaved} stillFavedAfterReopen=${stillFaved} favedTotal=${favedTotal}`);
    } catch (err) {
      await shot(page, '32x-heart-FAILURE');
      record('5ab-favorite-and-persist', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 5c: selection-bar add-to-album + album tools ----------
    try {
      await frameLoc.locator('#selectBtn').click();
      const tiles = frameLoc.locator('.tile-wrap');
      await tiles.nth(0).locator('.tile-check').click();
      await tiles.nth(1).locator('.tile-check').click();
      const barBtn = frameLoc.locator('.bar-btn', { hasText: 'Add to album' });
      await barBtn.click();
      const menu = frameLoc.locator('.album-menu');
      await menu.waitFor({ state: 'visible', timeout: 5000 });
      const menuBox = await menu.boundingBox();
      const btnBox = await barBtn.boundingBox();
      const anchored = menuBox && btnBox
        ? Math.abs((menuBox.y + menuBox.height) - btnBox.y) < 60 || Math.abs(menuBox.y - (btnBox.y + btnBox.height)) < 60
        : false;
      await shot(page, '33-album-menu-anchored');
      await frameLoc.locator('.album-menu-item', { hasText: 'Test Album' }).click();
      // runBatchAddToAlbum auto-exits select mode when done — wait for the bar to hide
      await frameLoc.locator('#selectionBar').waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(400);

      // switch to the album; count should now be >= 3 (2 from phase 1 + new, minus dupes)
      await frameLoc.locator('#albumChips .kit-chip', { hasText: 'Test Album' }).click();
      await page.waitForTimeout(400);
      const inAlbum = await frameLoc.locator('.tile-wrap').count();
      const toolsLabel = await frameLoc.locator('.album-tools-label').textContent();
      await shot(page, '34-album-view');

      // rename
      await frameLoc.locator('#albumTools .kit-btn', { hasText: 'Rename' }).click();
      const renameInput = frameLoc.locator('#albumTools input');
      await renameInput.waitFor({ state: 'visible', timeout: 5000 });
      await renameInput.fill('Renamed Album');
      await renameInput.press('Enter');
      await page.waitForTimeout(500);
      const renamedChipCount = await frameLoc.locator('#albumChips .kit-chip', { hasText: 'Renamed Album' }).count();
      await shot(page, '35-album-renamed');

      // remove one from album
      const beforeRemove = await frameLoc.locator('.tile-wrap').count();
      const firstInAlbum = frameLoc.locator('.tile-wrap').first();
      await firstInAlbum.hover();
      await page.waitForTimeout(200);
      await firstInAlbum.locator('.tile-remove').click();
      await page.waitForTimeout(500);
      const afterRemove = await frameLoc.locator('.tile-wrap').count();

      // delete album (two-step confirm)
      const deleteBtn = frameLoc.locator('#albumTools .kit-btn.danger', { hasText: /Delete/ });
      await deleteBtn.click();
      await page.waitForTimeout(200);
      const armedText = await deleteBtn.textContent();
      await shot(page, '36-delete-armed');
      await deleteBtn.click();
      await page.waitForTimeout(600);
      const albumChipGone = await frameLoc.locator('#albumChips .kit-chip', { hasText: 'Renamed Album' }).count();
      const backToAll = await frameLoc.locator('.tile-wrap').count();
      await shot(page, '37-album-deleted');
      record('5c-albums',
        anchored && renamedChipCount === 1 && afterRemove === beforeRemove - 1 && albumChipGone === 0 && backToAll > 0
          ? 'pass'
          : 'fail-escalated',
        `anchored=${anchored} inAlbumAfterAdd=${inAlbum} toolsLabel=${JSON.stringify(toolsLabel)} renamedChip=${renamedChipCount} remove:${beforeRemove}->${afterRemove} armed=${JSON.stringify(armedText)} chipGone=${albumChipGone === 0} allCount=${backToAll}`);
    } catch (err) {
      await shot(page, '33x-albums-FAILURE');
      record('5c-albums', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 6c: lightbox arrows at ends + delete-from-lightbox ----------
    try {
      const all = frameLoc.locator('.tile-wrap');
      const total = await all.count();
      // FIRST tile: prev must be disabled, next enabled
      await all.first().locator('.tile').click();
      const lightbox = frameLoc.locator('#lightbox');
      await lightbox.waitFor({ state: 'visible', timeout: 10_000 });
      const prevAtStart = await frameLoc.locator('.kit-viewer-nav.prev').isDisabled();
      const nextAtStart = await frameLoc.locator('.kit-viewer-nav.next').isDisabled();
      // walk to the LAST photo: next must become disabled there
      for (let i = 0; i < total - 1; i++) {
        await frameLoc.locator('.kit-viewer-nav.next').click();
        await page.waitForTimeout(150);
      }
      const nextAtEnd = await frameLoc.locator('.kit-viewer-nav.next').isDisabled();
      const prevAtEnd = await frameLoc.locator('.kit-viewer-nav.prev').isDisabled();
      await shot(page, '38-lightbox-at-end');
      // arrows didn't close it
      const stillOpen = await lightbox.isVisible();
      // delete from lightbox → closes, tile gone
      const currentAssetSrc = await frameLoc.locator('.lightbox-stage img').getAttribute('src').catch(() => null);
      const delBtn = frameLoc.locator('.lightbox-actions .kit-btn.danger');
      await delBtn.click(); // arm
      await page.waitForTimeout(150);
      await delBtn.click(); // confirm
      await page.waitForTimeout(700);
      const closedAfterDelete = !(await lightbox.isVisible());
      const countAfterDelete = await frameLoc.locator('.tile-wrap').count();
      await shot(page, '39-after-lightbox-delete');
      record('6c-lightbox-ends-and-delete',
        prevAtStart === true && nextAtStart === false && nextAtEnd === true && prevAtEnd === false && stillOpen && closedAfterDelete && countAfterDelete === total - 1
          ? 'pass'
          : 'fail-escalated',
        `prevAtStart=${prevAtStart} nextAtStart=${nextAtStart} nextAtEnd=${nextAtEnd} prevAtEnd=${prevAtEnd} stillOpenAfterArrows=${stillOpen} closedAfterDelete=${closedAfterDelete} tiles:${total}->${countAfterDelete} deletedSrc=${JSON.stringify(currentAssetSrc?.slice(0, 80))}`);
    } catch (err) {
      await shot(page, '38x-lightbox2-FAILURE');
      record('6c-lightbox-ends-and-delete', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 1b: Ask panel send via Enter (FAB blocks pointer on send) ----------
    try {
      await frameLoc.locator('#kitAskBtn').click();
      await page.waitForTimeout(200);
      const input = frameLoc.locator('.kit-ask-compose input');
      await input.fill('How many photos do I have?');
      await input.press('Enter');
      // watch the real _turn respond (or fail honestly)
      await page.waitForTimeout(6000);
      const bubbles = await frameLoc.locator('.kit-msg').allTextContents();
      const grantChip = await frameLoc.locator('[data-kit-grant]').textContent();
      // exact evidence for the grant-chip finding: what does _vault/status say in-frame?
      const statusProbe = await frameLoc.locator('body').evaluate(async () => {
        const r = await fetch('/centraid/_vault/status');
        return { status: r.status, body: (await r.text()).slice(0, 200) };
      });
      await shot(page, '40-ask-sent-real-turn');
      const wedged = await frameLoc.locator('#kitAskOverlay').evaluate((el) => getComputedStyle(el).display);
      await frameLoc.locator('.kit-ask-x').click();
      await page.waitForTimeout(200);
      const closed = await frameLoc.locator('#kitAskOverlay').evaluate((el) => getComputedStyle(el).display);
      record('1b-ask-send-real-turn', closed === 'none' ? 'pass' : 'fail-escalated',
        `bubbles=${JSON.stringify(bubbles).slice(0, 500)} grantChip=${JSON.stringify(grantChip)} vaultStatusProbe=${JSON.stringify(statusProbe)} openDisplay=${wedged} closedDisplay=${closed}`);
    } catch (err) {
      await shot(page, '40x-ask2-FAILURE');
      record('1b-ask-send-real-turn', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 9b: search on a known live title ----------
    try {
      const search = frameLoc.locator('#searchInput');
      await search.fill('teal');
      await page.waitForTimeout(400);
      const filtered = await frameLoc.locator('.tile-wrap').count();
      const clearVisible = await frameLoc.locator('#searchClear').isVisible();
      await shot(page, '41-search-teal');
      await frameLoc.locator('#searchClear').click();
      await page.waitForTimeout(300);
      const cleared = await frameLoc.locator('.tile-wrap').count();
      record('9b-search-live-title', filtered === 1 && clearVisible && cleared > filtered ? 'pass' : 'fail-escalated',
        `filtered=${filtered} clearVisible=${clearVisible} afterClear=${cleared}`);
    } catch (err) {
      record('9b-search-live-title', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 10: theme flip dark(default) -> light, iframe follows ----------
    try {
      const darkTheme = await frameLoc.locator('html').evaluate((el) => el.dataset.theme);
      await shot(page, '42-dark-default');
      await page.getByRole('button', { name: /^Settings/ }).first().click();
      const lightCard = page.locator('[data-name="light"]');
      await lightCard.waitFor({ state: 'visible', timeout: 10_000 });
      await lightCard.click();
      await page.waitForTimeout(600);
      await shot(page, '43-settings-light-picked');
      frameLoc = await openPhotos(page);
      await frameLoc.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(500);
      const lightThemeAttr = await frameLoc.locator('html').evaluate((el) => el.dataset.theme);
      const bodyBg = await frameLoc.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
      const h1Color = await frameLoc.locator('h1').first().evaluate((el) => getComputedStyle(el).color);
      const accent = await frameLoc.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--accent') || getComputedStyle(document.body).getPropertyValue('--accent'));
      await shot(page, '44-light-mode');
      record('10-theme-bridge', darkTheme === 'dark' && lightThemeAttr === 'light' ? 'pass' : 'fail-escalated',
        `defaultShellTheme=dark (baked: data-theme=${JSON.stringify(darkTheme)}); after flip data-theme=${JSON.stringify(lightThemeAttr)} bodyBg=${bodyBg} h1Color=${h1Color} accent=${accent.trim()}`);
    } catch (err) {
      await shot(page, '42x-theme-FAILURE');
      record('10-theme-bridge', 'fail-escalated', String(err?.message ?? err));
    }

    // final no-scrim smoke
    try {
      const disp = await page
        .frameLocator('iframe[data-centraid-app="1"]')
        .locator('#kitAskOverlay')
        .evaluate((el) => getComputedStyle(el).display);
      record('1c-ask-final-smoke', disp === 'none' ? 'pass' : 'fail-escalated', `display=${disp}`);
    } catch (err) {
      record('1c-ask-final-smoke', 'fail-escalated', String(err?.message ?? err));
    }

    console.log(`[phase2] done in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('[phase2] FATAL', err);
  } finally {
    const errs = consoleLog.filter((c) => c.type === 'error');
    const warns = consoleLog.filter((c) => c.type === 'warning');
    console.log(`\n[console-summary] total=${consoleLog.length} error=${errs.length} warning=${warns.length}`);
    const uniq = new Map();
    for (const c of [...errs, ...warns]) {
      const key = c.text.slice(0, 90);
      uniq.set(key, (uniq.get(key) ?? 0) + 1);
    }
    for (const [k, n] of uniq) console.log(`  x${n} ${k}`);
    console.log('\n[verdict-table]');
    for (const r of results) console.log(`  ${r.flow}: ${r.verdict}${r.note ? ' — ' + r.note : ''}`);
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
