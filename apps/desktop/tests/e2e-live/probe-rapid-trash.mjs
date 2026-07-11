#!/usr/bin/env node
// Minimal probe: create+trash 2 Locker items back-to-back with NO inter-item
// settle time, mirroring flows-approvals-02's createTrashParkLockerItem
// sequencing, to isolate whether the 2nd item vanishing from Trash is a
// product timing bug or specific to that test's own pacing.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-probe-rapid-trash');

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

async function createAndTrash(page, fl, title) {
  await fl
    .locator('button.v-nav-item', { hasText: 'All items' })
    .click({ timeout: 3000 })
    .catch(() => undefined);
  await fl.locator('.v-newbtn').click();
  const modal = fl.locator('.kit-modal');
  await modal.waitFor({ state: 'visible', timeout: 8000 });
  await modal.locator('.v-in').first().fill(title);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.waitFor({ state: 'hidden', timeout: 8000 });
  await fl.locator('.v-item', { hasText: title }).click();
  const detail = fl.locator('.v-detail-inner');
  await detail.waitFor({ state: 'visible', timeout: 8000 });
  await detail.getByRole('button', { name: 'Move to trash' }).click();
  await fl.locator('.v-list').waitFor({ state: 'visible', timeout: 8000 });
  await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
  const trashCount = await fl.locator('.v-item', { hasText: title }).count();
  console.log(
    `[probe] immediately after moving "${title}" to trash, Trash list count for it: ${trashCount}`,
  );
  if (trashCount === 0) {
    await page.waitForTimeout(1000);
    const retryCount = await fl.locator('.v-item', { hasText: title }).count();
    console.log(`[probe] after 1s extra wait, Trash list count for "${title}": ${retryCount}`);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  const page = session.page;
  try {
    await navTo(page, 'Discover');
    const lockerCard = page.locator('button[data-kind="app"]', { hasText: 'Locker' }).first();
    await lockerCard.waitFor({ state: 'visible', timeout: 20_000 });
    await lockerCard.click();
    const dialog = page.getByRole('dialog', { name: /^Preview Locker/ });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    await dialog.getByRole('button', { name: 'Use this template' }).click();
    await page.locator('[data-global-toast]').waitFor({ state: 'visible', timeout: 10_000 });
    const tile = page.locator('[data-app-id="locker"]');
    await tile.waitFor({ state: 'visible', timeout: 15_000 });
    await tile.getByTestId('app-tile').click();
    await page.waitForSelector('iframe[data-centraid-app="1"]', {
      state: 'attached',
      timeout: 20_000,
    });
    const fl = frameLoc(page);
    await fl.locator('.v-newbtn').waitFor({ state: 'visible', timeout: 15_000 });

    console.log('[probe] creating+trashing item 1 (alpha)…');
    await createAndTrash(page, fl, 'probe alpha');
    await page.screenshot({ path: path.join(OUT_DIR, 'probe-01-after-alpha.png') });

    console.log('[probe] creating+trashing item 2 (beta) immediately after, no pause…');
    await createAndTrash(page, fl, 'probe beta');
    await page.screenshot({ path: path.join(OUT_DIR, 'probe-02-after-beta.png') });

    const allInTrash = await fl.locator('.v-item').allTextContents();
    console.log(`[probe] FINAL Trash contents: ${JSON.stringify(allInTrash)}`);
  } catch (err) {
    console.error('FATAL:', err);
    await page.screenshot({ path: path.join(OUT_DIR, 'probe-FATAL.png') }).catch(() => undefined);
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main();
