#!/usr/bin/env node
// Photos e2e phase 5: fresh install verifying the dark-mode lightbox scrim
// fix (app.css) — the backdrop must be near-black in the default dark theme.
// Also re-runs the flow-1 Ask smoke on the fixed install.
// Run: node apps/desktop/tests/e2e-live/flows-photos-5.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'photos');
const SCRATCH =
  '/private/tmp/claude-502/-Users-srikanth-gitspace-centraid--claude-worktrees-blueprint-design-system-04c2f0/a2c18b64-1753-471c-9557-d71e4278c8cc/scratchpad';
const FRESH_DIR = path.join(SCRATCH, 'userdata', 'photos-e2e-fresh3');
const FIXTURES_DIR = path.join(SCRATCH, 'photos-fixtures');

async function main() {
  await fs.rm(FRESH_DIR, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(OUT_DIR, { recursive: true });
  const { page, close } = await launchApp({ userDataDir: FRESH_DIR });
  await page.setViewportSize({ width: 1400, height: 900 });
  try {
    await page.getByRole('button', { name: /^Discover/ }).first().click();
    const card = page.locator('button[data-kind="app"]', { hasText: 'Photos' });
    await card.first().waitFor({ state: 'visible', timeout: 20_000 });
    await card.first().click();
    const dialog = page.getByRole('dialog', { name: /^Preview Photos/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    const tile = page.locator('[data-app-id="photos"]');
    await tile.waitFor({ state: 'visible', timeout: 20_000 });
    await tile.getByTestId('app-tile').click();
    await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 30_000 });
    const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
    await frameLoc.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(300);
    // flow-1 smoke on the fixed install
    const askDisp = await frameLoc.locator('#kitAskOverlay').evaluate((el) => getComputedStyle(el).display);
    console.log(`[phase5] ask overlay on fresh open: display=${askDisp} (want none)`);
    await frameLoc.locator('#fileInput').setInputFiles([path.join(FIXTURES_DIR, 'teal-800.png')]);
    await frameLoc.locator('.tile-wrap').first().waitFor({ state: 'visible', timeout: 20_000 });
    await page.waitForTimeout(400);
    await frameLoc.locator('.tile-wrap').first().locator('.tile').click();
    await frameLoc.locator('#lightbox').waitFor({ state: 'visible', timeout: 10_000 });
    const theme = await frameLoc.locator('html').evaluate((el) => el.dataset.theme);
    const bg = await frameLoc.locator('#lightbox').evaluate((el) => getComputedStyle(el).backgroundColor);
    const p = path.join(OUT_DIR, '61-dark-lightbox-fixed.png');
    await page.screenshot({ path: p });
    console.log(`[phase5] theme=${theme} lightbox backgroundColor=${bg}`);
    console.log(`[shot] ${p}`);
    await page.keyboard.press('Escape');
  } finally {
    await close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
