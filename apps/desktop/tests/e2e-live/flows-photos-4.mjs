#!/usr/bin/env node
// Photos e2e phase 4: (a) fresh install verifying the setThumbSrc known-small
// guard (no variant=thumb 404s for small assets with recorded dims), and
// (b) Ask-send crash repro attempt against the phase-1 vault with
// main-process output captured.
// Run: node apps/desktop/tests/e2e-live/flows-photos-4.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'photos');
const SCRATCH =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-blueprint-design-system-04c2f0/a2c18b64-1753-471c-9557-d71e4278c8cc/scratchpad';
const FRESH_DIR = path.join(SCRATCH, 'userdata', 'photos-e2e-fresh2');
const PHASE1_DIR = path.join(SCRATCH, 'userdata', 'photos-e2e');
const FIXTURES_DIR = path.join(SCRATCH, 'photos-fixtures');

const results = [];
function record(flow, verdict, note) {
  results.push({ flow, verdict, note });
  console.log(`[flow] ${flow}: ${verdict}${note ? ' — ' + note : ''}`);
}

async function partA() {
  await fs.rm(FRESH_DIR, { recursive: true, force: true }).catch(() => {});
  const consoleLog = [];
  const { page, close } = await launchApp({ userDataDir: FRESH_DIR });
  page.on('console', (msg) => consoleLog.push({ text: msg.text(), type: msg.type() }));
  await page.setViewportSize({ width: 1400, height: 900 });
  try {
    await page
      .getByRole('button', { name: /^Discover/ })
      .first()
      .click();
    const card = page.locator('button[data-kind="app"]', { hasText: 'Photos' });
    await card.first().waitFor({ state: 'visible', timeout: 20_000 });
    await card.first().click();
    const dialog = page.getByRole('dialog', { name: /^Preview Photos/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    const tile = page.locator('[data-app-id="photos"]');
    await tile.waitFor({ state: 'visible', timeout: 20_000 });
    await tile.getByTestId('app-tile').click();
    await page.waitForSelector('iframe[data-centraid-app="1"]', {
      state: 'attached',
      timeout: 30_000,
    });
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    await frameLoc.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);
    const errBefore = consoleLog.filter((c) => c.type === 'error').length;
    await frameLoc
      .locator('#fileInput')
      .setInputFiles([
        path.join(FIXTURES_DIR, 'red-100.png'),
        path.join(FIXTURES_DIR, 'green-100.png'),
        path.join(FIXTURES_DIR, 'teal-800.png'),
      ]);
    await frameLoc.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(1500);
    const tiles = await frameLoc.locator('.tile-wrap').count();
    const newErrs = consoleLog
      .filter((c) => c.type === 'error')
      .slice(errBefore)
      .map((e) => e.text.slice(0, 130));
    const probe = await frameLoc.locator('body').evaluate(() => {
      return [...document.querySelectorAll('.tile-wrap img')].map((img) => ({
        src: (img.currentSrc || img.src).slice((img.currentSrc || img.src).indexOf('/centraid')),
        w: img.naturalWidth,
      }));
    });
    const p = path.join(OUT_DIR, '60-small-no-404.png');
    await page.screenshot({ path: p });
    record(
      '3d-small-image-404-skip',
      tiles === 3 && newErrs.length === 0 ? 'pass-after-fix' : 'fail-escalated',
      `tiles=${tiles} newConsoleErrorsDuringUploadAndRender=${JSON.stringify(newErrs)} imgs=${JSON.stringify(probe)}`,
    );
    // reload the view once more to prove steady-state renders stay silent
    await page.getByRole('button', { name: /^Home/ }).first().click();
    await page
      .getByRole('heading', { name: 'What should we build?' })
      .waitFor({ state: 'visible', timeout: 15_000 });
    const errBeforeReopen = consoleLog.filter((c) => c.type === 'error').length;
    await page.locator('[data-app-id="photos"]').getByTestId('app-tile').click();
    const fl2 = page.frameLocator('iframe[data-centraid-app="1"]');
    await fl2.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(1200);
    const reopenErrs = consoleLog
      .filter((c) => c.type === 'error')
      .slice(errBeforeReopen)
      .map((e) => e.text.slice(0, 130));
    record(
      '3e-steady-state-console-clean',
      reopenErrs.length === 0 ? 'pass-after-fix' : 'fail-escalated',
      `errorsOnReopenRender=${JSON.stringify(reopenErrs)}`,
    );
  } finally {
    await close();
  }
}

async function partB() {
  const { app, page, close } = await launchApp({ userDataDir: PHASE1_DIR });
  const mainLines = [];
  app.process().stdout?.on('data', (d) => mainLines.push(String(d)));
  app.process().stderr?.on('data', (d) => mainLines.push(String(d)));
  let pageClosed = false;
  page.on('close', () => {
    pageClosed = true;
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  try {
    await page.getByRole('button', { name: /^Home/ }).first().click();
    await page
      .getByRole('heading', { name: 'What should we build?' })
      .waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('[data-app-id="photos"]').getByTestId('app-tile').click();
    await page.waitForSelector('iframe[data-centraid-app="1"]', {
      state: 'attached',
      timeout: 20_000,
    });
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    await frameLoc.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
    await frameLoc.locator('#kitAskBtn').click();
    await page.waitForTimeout(250);
    const input = frameLoc.locator('.kit-ask-compose input');
    await input.fill('How many photos do I have?');
    await input.press('Enter');
    for (let i = 0; i < 12 && !pageClosed; i++) await page.waitForTimeout(1000);
    if (pageClosed) {
      record(
        '1f-ask-crash-repro',
        'fail-escalated',
        `REPRODUCED: window closed during _turn send on the phase-1 vault. main tail=${JSON.stringify(mainLines.slice(-8).join('').slice(-800))}`,
      );
    } else {
      const bubbles = await frameLoc.locator('.kit-msg').allTextContents();
      record(
        '1f-ask-crash-repro',
        'pass',
        `no crash on retry; bubbles=${JSON.stringify(bubbles).slice(0, 400)}`,
      );
    }
  } catch (err) {
    record(
      '1f-ask-crash-repro',
      pageClosed ? 'fail-escalated' : 'not-testable',
      `${String(err?.message ?? err).slice(0, 200)}; pageClosed=${pageClosed}; main tail=${JSON.stringify(mainLines.slice(-8).join('').slice(-800))}`,
    );
  } finally {
    await close();
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await partA();
  await partB();
  console.log('\n[verdict-table]');
  for (const r of results) console.log(`  ${r.flow}: ${r.verdict}${r.note ? ' — ' + r.note : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
