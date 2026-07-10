#!/usr/bin/env node
// Micro-probe: Discover template preview closes via its X button (the v1/v2
// suites cover Escape close; this covers the pointer path). Also opens a
// second and third preview back-to-back to confirm re-openability.
import { launchApp, navTo } from './driver.mjs';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'shell-v2');

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const session = await launchApp();
  const { page } = session;
  let failed = false;
  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await navTo(page, 'Discover');
    const cards = page.locator('button[data-kind="app"]');
    await cards.first().waitFor({ state: 'visible', timeout: 20_000 });

    for (const idx of [0, 1, 2]) {
      await cards.nth(idx).click();
      const dialog = page.getByRole('dialog', { name: /^Preview / });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      const name = await dialog.getAttribute('aria-label');
      // Close via the X button (aria-label Close, or the ✕ glyph button).
      const closeBtn = dialog.getByRole('button', { name: /^(Close|✕|×)$/ }).first();
      const hasClose = await closeBtn.isVisible().catch(() => false);
      if (!hasClose) {
        // fall back: any button whose accessible name mentions close
        const alt = dialog.locator('button[aria-label*="lose"]').first();
        if (await alt.isVisible().catch(() => false)) {
          await alt.click();
        } else {
          await page.screenshot({ path: path.join(OUT_DIR, 'probe-x-close-FAILURE.png') });
          throw new Error(`no X/Close button found in preview dialog "${name}"`);
        }
      } else {
        await closeBtn.click();
      }
      await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
      console.log(`[probe] preview ${idx} ("${name}") closed via X`);
    }
    console.log('PASS preview X-close x3');
  } catch (err) {
    failed = true;
    console.error('FAIL:', err);
    await page.screenshot({ path: path.join(OUT_DIR, 'probe-x-close-FAILURE.png') }).catch(() => undefined);
  } finally {
    await session.close();
  }
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
