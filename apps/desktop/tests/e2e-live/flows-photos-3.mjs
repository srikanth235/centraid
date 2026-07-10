#!/usr/bin/env node
// Photos e2e phase 3: FRESH vault + fresh install (picks up the
// createImageBitmap fix, since installed apps snapshot blueprint source into
// the vault code store at install time). Verifies: served code is the fixed
// one, upload with zero blob-CSP errors + staged thumb variants, consent
// seam on first open, Ask _turn send (with main-process logs — phase 2 saw
// the window close during this), search, shell theme flip -> iframe follows.
// Run: node apps/desktop/tests/e2e-live/flows-photos-3.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'photos');
const USER_DATA_DIR =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-blueprint-design-system-04c2f0/a2c18b64-1753-471c-9557-d71e4278c8cc/scratchpad/userdata/photos-e2e-fresh';
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

async function main() {
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const { app, page, close } = await launchApp({ userDataDir: USER_DATA_DIR });
  console.log(`[phase3] fresh launch in ${Date.now() - t0}ms`);
  // main-process output — to catch whatever closed the window in phase 2
  app.process().stdout?.on('data', (d) => console.log(`[main-stdout] ${String(d).trim().slice(0, 500)}`));
  app.process().stderr?.on('data', (d) => console.log(`[main-stderr] ${String(d).trim().slice(0, 500)}`));
  page.on('console', (msg) => consoleLog.push({ text: msg.text(), type: msg.type(), frameUrl: msg.location()?.url ?? '' }));
  page.on('pageerror', (err) => consoleLog.push({ text: `[pageerror] ${err.message}`, type: 'error', frameUrl: '' }));
  page.on('close', () => console.log('[phase3] !!! page closed'));
  await page.setViewportSize({ width: 1400, height: 900 });

  try {
    // install fresh
    await page.getByRole('button', { name: /^Discover/ }).first().click();
    const photosCard = page.locator('button[data-kind="app"]', { hasText: 'Photos' });
    await photosCard.first().waitFor({ state: 'visible', timeout: 20_000 });
    await photosCard.first().click();
    const dialog = page.getByRole('dialog', { name: /^Preview Photos/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    const tile = page.locator('[data-app-id="photos"]');
    await tile.waitFor({ state: 'visible', timeout: 20_000 });
    await tile.getByTestId('app-tile').click();
    await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 30_000 });
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    await frameLoc.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(400);

    // ---------- FLOW 12: consent seam on FIRST open ----------
    try {
      const consentHidden = await frameLoc.locator('#consentBanner').evaluate((el) => el.hidden);
      const consentText = await frameLoc.locator('#consentBanner').textContent();
      const emptyVisible = await frameLoc.locator('#empty').isVisible();
      await shot(page, '50-first-open-consent-state');
      record('12-consent-seam', 'pass',
        `consentBannerHidden=${consentHidden} (text=${JSON.stringify(consentText?.trim().slice(0, 80))}) emptyStateShown=${emptyVisible} — data straight away, install-time grants`);
    } catch (err) {
      record('12-consent-seam', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- served-code check: is the fix live in THIS install? ----------
    try {
      const probe = await frameLoc.locator('body').evaluate(async () => {
        const r = await fetch('upload.js');
        const t = await r.text();
        return {
          status: r.status,
          hasBitmapFix: t.includes('createImageBitmap'),
          hasOldBlobPath: t.includes('createObjectURL'),
        };
      });
      record('fix-served', probe.hasBitmapFix && !probe.hasOldBlobPath ? 'pass-after-fix' : 'fail-escalated', JSON.stringify(probe));
    } catch (err) {
      record('fix-served', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 3c: upload with fix — zero blob CSP errors, thumbs stage ----------
    try {
      const errBefore = consoleLog.filter((c) => c.type === 'error').length;
      await frameLoc.locator('#fileInput').setInputFiles([
        path.join(FIXTURES_DIR, 'teal-800.png'),
        path.join(FIXTURES_DIR, 'magenta-800.png'),
        path.join(FIXTURES_DIR, 'red-100.png'),
        path.join(FIXTURES_DIR, 'green-100.png'),
      ]);
      await frameLoc.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(1200);
      const tiles = await frameLoc.locator('.tile-wrap').count();
      const newErrs = consoleLog.filter((c) => c.type === 'error').slice(errBefore).map((e) => e.text.slice(0, 110));
      const blobErrs = newErrs.filter((t) => t.includes('blob:'));
      // find the teal-800 tile via search, then probe its img src
      const probe = await frameLoc.locator('body').evaluate(async () => {
        const out = [];
        for (const wrap of document.querySelectorAll('.tile-wrap')) {
          const img = wrap.querySelector('img');
          if (!img) continue;
          const src = img.currentSrc || img.src;
          const r = await fetch(src);
          out.push({ src: src.slice(src.indexOf('/centraid')), status: r.status, thumbVariant: src.includes('variant=thumb'), w: img.naturalWidth });
        }
        return out;
      });
      await shot(page, '51-upload-fixed');
      const thumbHits = probe.filter((p) => p.thumbVariant && p.status === 200);
      record('3c-upload-thumb-fix-verified',
        tiles === 4 && blobErrs.length === 0 && thumbHits.length >= 2 ? 'pass-after-fix' : 'fail-escalated',
        `tiles=${tiles} blobCspErrors=${blobErrs.length} imgProbes=${JSON.stringify(probe)} otherNewErrors=${JSON.stringify(newErrs.filter((t) => !t.includes('blob:')))}`);
    } catch (err) {
      await shot(page, '51x-upload-fix-FAILURE');
      record('3c-upload-thumb-fix-verified', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 9c: search on live titles ----------
    try {
      const search = frameLoc.locator('#searchInput');
      await search.fill('teal');
      await page.waitForTimeout(400);
      const filtered = await frameLoc.locator('.tile-wrap').count();
      const clearVisible = await frameLoc.locator('#searchClear').isVisible();
      const emptyOnMiss = await (async () => {
        await search.fill('zebra-nonexistent');
        await page.waitForTimeout(400);
        return {
          tiles: await frameLoc.locator('.tile-wrap').count(),
          text: await frameLoc.locator('#emptyText').textContent(),
        };
      })();
      await shot(page, '52-search-no-match');
      await frameLoc.locator('#searchClear').click();
      await page.waitForTimeout(300);
      const cleared = await frameLoc.locator('.tile-wrap').count();
      const clearHidden = await frameLoc.locator('#searchClear').isHidden();
      record('9c-search', filtered === 1 && clearVisible && emptyOnMiss.tiles === 0 && cleared === 4 && clearHidden ? 'pass' : 'fail-escalated',
        `filtered(teal)=${filtered} clearVisible=${clearVisible} noMatch=${JSON.stringify(emptyOnMiss)} afterClear=${cleared} clearBtnHiddenAfter=${clearHidden}`);
    } catch (err) {
      record('9c-search', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 1d: Ask send against the real _turn (crash watch) ----------
    try {
      await frameLoc.locator('#kitAskBtn').click();
      await page.waitForTimeout(250);
      const input = frameLoc.locator('.kit-ask-compose input');
      await input.fill('How many photos do I have?');
      await input.press('Enter');
      let closedDuringTurn = false;
      page.once('close', () => {
        closedDuringTurn = true;
      });
      for (let i = 0; i < 15 && !closedDuringTurn; i++) await page.waitForTimeout(1000);
      if (closedDuringTurn) {
        record('1d-ask-real-turn', 'fail-escalated', 'Electron window CLOSED during the _turn send (reproduced phase-2 crash)');
      } else {
        const bubbles = await frameLoc.locator('.kit-msg').allTextContents();
        const typingLeft = await frameLoc.locator('.kit-ask-typing').count();
        const grantChip = await frameLoc.locator('[data-kit-grant]').textContent();
        const statusProbe = await frameLoc.locator('body').evaluate(async () => {
          const r = await fetch('/centraid/_vault/status');
          return { status: r.status, body: (await r.text()).slice(0, 200) };
        });
        await shot(page, '53-ask-turn-response');
        await frameLoc.locator('.kit-ask-x').click();
        await page.waitForTimeout(200);
        const closed = await frameLoc.locator('#kitAskOverlay').evaluate((el) => getComputedStyle(el).display);
        record('1d-ask-real-turn', closed === 'none' ? 'pass' : 'fail-escalated',
          `bubbles=${JSON.stringify(bubbles).slice(0, 600)} typingIndicatorLeft=${typingLeft} grantChip=${JSON.stringify(grantChip)} vaultStatus=${JSON.stringify(statusProbe)} panelClosed=${closed === 'none'}`);
      }
    } catch (err) {
      await shot(page, '53x-ask-FAILURE').catch(() => {});
      record('1d-ask-real-turn', 'fail-escalated', String(err?.message ?? err));
    }

    // ---------- FLOW 10b: shell theme flip -> iframe follows ----------
    try {
      const darkAttr = await frameLoc.locator('html').evaluate((el) => el.dataset.theme);
      const darkBg = await frameLoc.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
      await shot(page, '54-dark-default');
      await page.getByRole('button', { name: /^Settings/ }).first().click();
      const lightCard = page.locator('[data-name="light"]');
      await lightCard.waitFor({ state: 'visible', timeout: 10_000 });
      await lightCard.click();
      await page.waitForTimeout(600);
      // back to the app
      await page.getByRole('button', { name: /^Home/ }).first().click();
      await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.locator('[data-app-id="photos"]').getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
      const fl2 = page.frameLocator('iframe[data-centraid-app="1"]');
      await fl2.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(500);
      const lightAttr = await fl2.locator('html').evaluate((el) => el.dataset.theme);
      const lightBg = await fl2.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor);
      const h1Color = await fl2.locator('h1').first().evaluate((el) => getComputedStyle(el).color);
      const accent = await fl2.locator('body').evaluate((el) => getComputedStyle(el).getPropertyValue('--accent'));
      await shot(page, '55-light-mode');
      record('10b-theme-bridge',
        darkAttr === 'dark' && lightAttr === 'light' && darkBg !== lightBg ? 'pass' : 'fail-escalated',
        `dark: data-theme=${darkAttr} bg=${darkBg}; light: data-theme=${lightAttr} bg=${lightBg} h1=${h1Color} accent=${accent.trim()}`);
    } catch (err) {
      await shot(page, '54x-theme-FAILURE').catch(() => {});
      record('10b-theme-bridge', 'fail-escalated', String(err?.message ?? err));
    }

    // final no-scrim smoke
    try {
      const disp = await page
        .frameLocator('iframe[data-centraid-app="1"]')
        .locator('#kitAskOverlay')
        .evaluate((el) => getComputedStyle(el).display);
      record('1e-ask-final-smoke', disp === 'none' ? 'pass' : 'fail-escalated', `display=${disp}`);
    } catch (err) {
      record('1e-ask-final-smoke', 'fail-escalated', String(err?.message ?? err));
    }

    console.log(`[phase3] done in ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('[phase3] FATAL', err);
    await shot(page, '5x-phase3-FATAL').catch(() => {});
  } finally {
    const errs = consoleLog.filter((c) => c.type === 'error');
    const warns = consoleLog.filter((c) => c.type === 'warning');
    console.log(`\n[console-summary] total=${consoleLog.length} error=${errs.length} warning=${warns.length}`);
    const uniq = new Map();
    for (const c of [...errs, ...warns]) {
      const key = c.text.slice(0, 100);
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
