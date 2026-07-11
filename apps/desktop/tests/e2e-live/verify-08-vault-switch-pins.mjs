#!/usr/bin/env node
// Verify fix #8: vault switch no longer destroys Home pins
// (apps/desktop/src/renderer/react/shell/useShellApps.ts -- refresh() now
// parks the outgoing vault's pins under home.userApps.byVault[vid] BEFORE
// pruning orphans, and restores the incoming vault's own set, instead of
// treating every pin as orphaned against the new vault's app listing and
// permanently deleting them -- which demoted the installed app to a "draft"
// tile with a DRAFT badge).
//
// Flow: install Notes (pinned to Home) -> Settings -> Spaces -> create a
// second space (auto-switches, Home should be empty) -> switch back via the
// sidebar vault switcher -> Notes must still be a normal pinned tile, NOT a
// draft/DRAFT-badged tile. Then fully relaunch (same userDataDir) and
// re-check.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-08');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;

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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v08-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v08-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function assertNotesNotDraft(label) {
  const tile = page.locator('[data-app-id="notes"]');
  await tile.waitFor({ state: 'visible', timeout: 15_000 });
  const tileText = (await tile.textContent().catch(() => '')).toLowerCase();
  console.log(`[v08] (${label}) Notes tile text: ${JSON.stringify(tileText)}`);
  assert(
    !tileText.includes('draft'),
    `(${label}) Notes tile shows a "draft" badge/description -- pin was demoted to a draft after the vault switch: ${tileText}`,
  );
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  page.setDefaultTimeout(60_000);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install-notes', 'Discover -> install Notes (pins it to Home)', async () => {
      await navTo(page, 'Discover');
      const card = page.locator('button[data-kind="app"]', { hasText: 'Notes' }).first();
      await card.waitFor({ state: 'visible', timeout: 20_000 });
      await card.click();
      const dialog = page.getByRole('dialog', { name: /^Preview Notes/ });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Use this template' }).click();
      await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
      await navTo(page, 'Home');
      await assertNotesNotDraft('initial install');
      await shot('01-home-notes-pinned');
    });

    await step(
      'create-second-space',
      'Settings -> Spaces -> Add profile -> auto-switches to a new, empty vault',
      async () => {
        await page
          .getByRole('button', { name: /^Settings/ })
          .first()
          .click();
        await page
          .getByRole('heading', { name: 'Appearance' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.getByRole('button', { name: 'Spaces', exact: true }).click();
        await page.waitForTimeout(400);
        await page.getByRole('button', { name: /Add profile/ }).click();
        const modal = page.getByRole('dialog');
        await modal.first().waitFor({ state: 'visible', timeout: 10_000 });
        const nameInput = modal.first().locator('input[type="text"]').first();
        await nameInput.fill('QA Pin Space');
        await page.waitForTimeout(200);
        await modal.getByRole('button', { name: 'Create profile' }).click();
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForTimeout(1000);
        await shot('02-home-new-space-empty');
        const notesTileCount = await page.locator('[data-app-id="notes"]').count();
        assert(
          notesTileCount === 0,
          'the new space should start empty -- Notes from the original vault must not leak in',
        );
      },
    );

    await step(
      'switch-back-notes-still-pinned',
      'Switch back via the sidebar vault switcher -- Notes must be a normal pinned tile, not demoted to DRAFT',
      async () => {
        const head = page
          .locator(
            '[class*="ProfileSwitcherHead"], [class*="profileSwitcher"], [class*="switcher"]',
          )
          .first();
        const headVisible = await head.isVisible().catch(() => false);
        if (headVisible) {
          await head.click();
        } else {
          await page.keyboard.press('Meta+Shift+G');
        }
        const menu = page.getByRole('menu');
        await menu.waitFor({ state: 'visible', timeout: 5000 });
        await shot('03-vault-switcher-menu');
        await menu.getByRole('menuitem', { name: /Owner/ }).click();
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForTimeout(1000);
        await shot('04-home-back-on-primary-vault');
        await assertNotesNotDraft('after switch-back, same session');

        // Extra corroboration: a genuine pinned tile has no StatusPill tone at
        // all, and clicking it should open the real live app (an iframe), not
        // a builder/draft editor route.
        await page.locator('[data-app-id="notes"]').getByTestId('app-tile').click();
        await page.waitForSelector('iframe[data-centraid-app="1"]', {
          state: 'attached',
          timeout: 20_000,
        });
        await shot('05-notes-opens-as-live-app-not-draft');
        await navTo(page, 'Home');
      },
    );

    await step(
      'relaunch-still-fine',
      'Fully relaunch (same userDataDir) -- Notes still a normal pinned tile after restart',
      async () => {
        await session.close();
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        page.setDefaultTimeout(60_000);
        await page.waitForTimeout(500);
        await assertNotesNotDraft('after full relaunch');
        await shot('06-home-after-relaunch');
      },
    );

    // ---- Report ----
    console.log('\n================ VERIFY-08 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-08 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v08-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v08] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
