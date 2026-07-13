#!/usr/bin/env node
// Golden-path smoke test against the REAL desktop app — real embedded
// gateway, real dev vault, no fixtures. Run with:
//   node apps/desktop/tests/e2e-live/smoke.mjs
// (prereq: `bun run build --filter=@centraid/desktop` from repo root)
//
// Path: launch → Home renders → Discover → 24 bundled templates render →
// open one template's preview → close it → back to Home → screenshot →
// clean shutdown.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const { page, userDataDir, close } = await launchApp();
  console.log(`[smoke] launched + Home ready in ${Date.now() - t0}ms (userData=${userDataDir})`);

  try {
    // Home renders (already asserted by launchApp's readiness wait) — grab a
    // screenshot baseline too, useful when a later step fails.
    await page.setViewportSize({ width: 1400, height: 900 });

    // → Discover.
    await navTo(page, 'Discover');
    const tiles = page.locator('button[data-kind]');
    await tiles.first().waitFor({ state: 'visible', timeout: 20_000 });
    const count = await tiles.count();
    console.log(`[smoke] Discover rendered ${count} template tiles`);
    assert(count === 24, `expected 24 bundled templates, got ${count}`);
    const appCount = await page.locator('button[data-kind="app"]').count();
    const autoCount = await page.locator('button[data-kind="automation"]').count();
    console.log(`[smoke] breakdown: ${appCount} app templates, ${autoCount} automation templates`);
    assert(appCount === 8, `expected 8 app templates, got ${appCount}`);
    assert(autoCount === 16, `expected 16 automation templates, got ${autoCount}`);

    // Open one app template's preview modal.
    await page.locator('button[data-kind="app"]').first().click();
    const dialog = page.getByRole('dialog', { name: /^Preview / });
    await dialog.waitFor({ state: 'visible', timeout: 10_000 });
    console.log('[smoke] template preview dialog opened');

    // Close it (Escape — wired in templatePreview.ts's onKey handler).
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5_000 });
    console.log('[smoke] template preview dialog closed');

    // ← back to Home.
    await navTo(page, 'Home');
    await page
      .getByRole('heading', { name: 'What should we build?' })
      .waitFor({ state: 'visible', timeout: 10_000 });
    console.log('[smoke] back on Home');

    const shot = path.join(OUT_DIR, 'smoke-home.png');
    await page.screenshot({ path: shot });
    console.log(`[smoke] wrote ${shot}`);

    console.log(`[smoke] PASS in ${Date.now() - t0}ms total`);
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'smoke-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[smoke] FAIL — screenshot at ${failShot}`);
    throw err;
  } finally {
    await close();
    await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
