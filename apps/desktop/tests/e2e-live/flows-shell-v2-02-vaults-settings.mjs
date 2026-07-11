#!/usr/bin/env node
// Shell QA v2 Suite 2: Settings deep-walk beyond the v1 tab sweep —
// Spaces (vault) lifecycle: create a second space via "Add profile"
// (auto-switches, Home shows empty state), switch back via the sidebar
// vault-switcher popover (Cmd+Shift+G surface), delete the second space
// (confirm dialog), Connections pane empty state + "Add connection" CTA,
// and toggle persistence: Appearance "Cool blue cast" + Layout "Show
// sidebar" survive a full relaunch (same userDataDir).
//
// Run with: node tests/e2e-live/flows-shell-v2-02-vaults-settings.mjs  (from apps/desktop)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'shell-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-shell-v2-02');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type() });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error' });
  });
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
      await page.screenshot({ path: path.join(OUT_DIR, `02-${id}-FAILURE.png`) });
    } catch {
      /* ignore */
    }
    // Dismiss any overlay (menu/dialog/scrim) a failed step left open so
    // later steps aren't poisoned by a stale pointer-event trap.
    try {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `02-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function openSettingsPage(pageLabel) {
  await page
    .getByRole('button', { name: /^Settings/ })
    .first()
    .click();
  await page
    .getByRole('heading', { name: 'Appearance' })
    .waitFor({ state: 'visible', timeout: 15_000 });
  if (pageLabel !== 'Appearance') {
    await page.getByRole('button', { name: pageLabel, exact: true }).click();
    await page.waitForTimeout(400);
  }
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[v2-02] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---------- Fixture: install Notes so the primary vault is non-empty ----------
    await step(
      'fixture-install-notes',
      'Install Notes so vault-switch empty/populated contrast is visible',
      async () => {
        await navTo(page, 'Discover');
        const card = page.locator('button[data-kind="app"]', { hasText: 'Notes' }).first();
        await card.waitFor({ state: 'visible', timeout: 20_000 });
        await card.click();
        const dialog = page.getByRole('dialog', { name: /^Preview Notes/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use this template' }).click();
        await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
        await shot('01-home-populated-primary-vault');
      },
    );

    // ---------- Settings nav active state ----------
    await step(
      'settings-nav-active-state',
      'Settings nav marks the open page active (data-active)',
      async () => {
        await openSettingsPage('Appearance');
        const activeItem = page.locator('[data-active="true"]').filter({ hasText: 'Appearance' });
        assert((await activeItem.count()) >= 1, 'Appearance nav item not marked data-active=true');
        await page.getByRole('button', { name: 'Layout', exact: true }).click();
        await page.waitForTimeout(300);
        const activeLayout = page.locator('[data-active="true"]').filter({ hasText: 'Layout' });
        assert((await activeLayout.count()) >= 1, 'Layout nav item not marked active after click');
        const staleAppearance = await page
          .locator('button[data-active="true"]')
          .filter({ hasText: 'Appearance' })
          .count();
        assert(staleAppearance === 0, 'Appearance still marked active after switching to Layout');
        await shot('02-settings-active-state');
      },
    );

    // ---------- Connections pane ----------
    await step(
      'settings-connections-empty',
      'Connections pane renders empty state + Add connection CTA',
      async () => {
        await page.getByRole('button', { name: 'Connections', exact: true }).click();
        await page
          .getByRole('heading', { name: 'Connections' })
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(500);
        const bodyText = await page.locator('body').textContent();
        assert(
          /No connections configured yet\./.test(bodyText),
          'expected empty-state copy "No connections configured yet."',
        );
        const addBtn = page.getByRole('button', { name: /Add connection/ });
        await addBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await shot('03-connections-empty');
        // Open the add-connection wizard, screenshot it, close via its own
        // Cancel button (exact name — /Back/ would match the chrome nav arrow
        // and walk the router back to Home).
        await addBtn.click();
        await page.waitForTimeout(500);
        await shot('03-connections-add-wizard');
        const cancelBtn = page.getByRole('button', { name: 'Cancel', exact: true }).first();
        await cancelBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await cancelBtn.click();
        await page.waitForTimeout(300);
        const wizardGone = await page.getByRole('button', { name: 'Save connection' }).count();
        assert(wizardGone === 0, 'add-connection wizard still open after Cancel');
      },
    );

    // ---------- Toggles: flip Cool blue cast + Show sidebar ----------
    await step('toggle-cool-blue-cast', 'Appearance "Cool blue cast" toggle flips', async () => {
      await page.getByRole('button', { name: 'Appearance', exact: true }).click();
      await page.waitForTimeout(300);
      const sw = page.getByRole('switch', { name: 'Cool blue cast' });
      await sw.waitFor({ state: 'visible', timeout: 10_000 });
      const before = await sw.getAttribute('aria-checked');
      assert(before === 'true', `Cool blue cast should default ON, got ${before}`);
      await sw.click();
      await page.waitForTimeout(300);
      const after = await sw.getAttribute('aria-checked');
      console.log(`[v2-02] Cool blue cast: ${before} -> ${after}`);
      // Flip OFF (non-default) so relaunch-persistence below is a real check.
      assert(after === 'false', `expected toggle OFF after flip, got ${after}`);
      await shot('04-cool-blue-cast-off');
    });

    await step(
      'toggle-sidebar-off',
      'Layout "Show sidebar" toggle hides the sidebar live',
      async () => {
        await page.getByRole('button', { name: 'Layout', exact: true }).click();
        await page.waitForTimeout(300);
        const sw = page.getByRole('switch', { name: 'Show sidebar' });
        await sw.waitFor({ state: 'visible', timeout: 10_000 });
        assert(
          (await sw.getAttribute('aria-checked')) === 'true',
          'sidebar switch should start ON',
        );
        await sw.click();
        await page.waitForTimeout(500);
        const sidebarState = await page
          .locator('[data-sidebar]')
          .first()
          // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- (#363) this is a Playwright Locator, not a DOM node; Locator has no .dataset
          .getAttribute('data-sidebar')
          .catch(() => null);
        console.log(`[v2-02] data-sidebar after toggle off: ${sidebarState}`);
        assert(sidebarState === 'closed', `expected data-sidebar="closed", got ${sidebarState}`);
        await shot('05-sidebar-hidden-via-settings');
        // Turn it back on for the rest of the suite.
        await sw.click();
        await page.waitForTimeout(500);
        const restored = await page
          .locator('[data-sidebar]')
          .first()
          // oxlint-disable-next-line unicorn/prefer-dom-node-dataset -- (#363) this is a Playwright Locator, not a DOM node; Locator has no .dataset
          .getAttribute('data-sidebar')
          .catch(() => null);
        assert(
          restored === 'open',
          `expected data-sidebar="open" after re-toggle, got ${restored}`,
        );
      },
    );

    // ---------- Spaces: create a second vault ----------
    await step(
      'space-create',
      'Add profile -> SpaceModal -> create -> auto-switch -> Home is empty',
      async () => {
        await page.getByRole('button', { name: 'Spaces', exact: true }).click();
        await page.waitForTimeout(400);
        await shot('06-spaces-before-add');
        await page.getByRole('button', { name: /Add profile/ }).click();
        const modal = page.getByRole('dialog');
        await modal.first().waitFor({ state: 'visible', timeout: 10_000 });
        await shot('06-space-modal-open');

        // Create button disabled with empty name.
        const createBtn = page.getByRole('button', { name: 'Create profile' });
        assert(await createBtn.isDisabled(), 'Create profile should be disabled with empty name');

        const nameInput = modal.first().locator('input[type="text"]').first();
        await nameInput.fill('QA Second Space');
        await page.waitForTimeout(200);
        assert(
          !(await createBtn.isDisabled()),
          'Create profile still disabled after typing a name',
        );
        await createBtn.click();

        // Creating auto-switches to the new vault and navigates Home.
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForTimeout(1_000);
        await shot('07-home-after-switch-to-new-space');
        const bodyText = await page.locator('body').textContent();
        assert(
          /Nothing here yet|No apps yet/.test(bodyText),
          'new space Home should show the empty state',
        );
        const notesTileCount = await page.locator('[data-app-id="notes"]').count();
        assert(notesTileCount === 0, 'Notes tile from the primary vault leaked into the new space');
        const sidebarText = await page.locator('body').textContent();
        assert(
          /QA Second Space/.test(sidebarText),
          'sidebar head does not show the new space name',
        );
      },
    );

    // ---------- Switch back via the sidebar vault-switcher popover ----------
    await step(
      'space-switch-back',
      'Sidebar vault switcher lists both spaces; switching back restores Notes',
      async () => {
        // The switcher is the profile head at the top of the sidebar.
        const head = page
          .locator(
            '[class*="ProfileSwitcherHead"], [class*="profileSwitcher"], [class*="switcher"]',
          )
          .first();
        const headVisible = await head.isVisible().catch(() => false);
        if (headVisible) {
          await head.click();
        } else {
          // Fall back to the keyboard shortcut the Settings copy advertises.
          await page.keyboard.press('Meta+Shift+G');
        }
        const menu = page.getByRole('menu');
        await menu.waitFor({ state: 'visible', timeout: 5_000 });
        const menuText = await menu.textContent();
        console.log(`[v2-02] vault switcher menu: ${JSON.stringify(menuText)}`);
        assert(/Owner/.test(menuText ?? ''), 'switcher does not list the primary vault');
        assert(/QA Second Space/.test(menuText ?? ''), 'switcher does not list the new space');
        await shot('08-vault-switcher-popover');
        await menu.getByRole('menuitem', { name: /Owner/ }).click();
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
        await shot('09-home-back-on-primary-vault');
      },
    );

    // ---------- Delete the second vault ----------
    await step(
      'space-delete',
      'Delete the second space via Settings -> Spaces trash icon + confirm dialog',
      async () => {
        await openSettingsPage('Spaces');
        await page.waitForTimeout(500);
        const delBtn = page.getByRole('button', { name: 'Delete QA Second Space' });
        await delBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await delBtn.click();
        const confirmDialog = page.getByRole('dialog', { name: 'Delete space?' });
        await confirmDialog.waitFor({ state: 'visible', timeout: 5_000 });
        await shot('10-delete-space-confirm');
        // First: Cancel keeps it.
        await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
        await confirmDialog.waitFor({ state: 'hidden', timeout: 5_000 });
        assert(
          (await page.getByRole('button', { name: 'Delete QA Second Space' }).count()) === 1,
          'space vanished after CANCEL',
        );
        // Then: confirm deletes it.
        await page.getByRole('button', { name: 'Delete QA Second Space' }).click();
        const confirm2 = page.getByRole('dialog', { name: 'Delete space?' });
        await confirm2.waitFor({ state: 'visible', timeout: 5_000 });
        await confirm2.getByRole('button', { name: 'Delete', exact: true }).click();
        // The success toast contains the space name — assert on the row's
        // delete button disappearing, not on body text.
        await page
          .getByRole('button', { name: 'Delete QA Second Space' })
          .waitFor({ state: 'hidden', timeout: 10_000 });
        assert(
          (await page.getByRole('button', { name: 'Delete QA Second Space' }).count()) === 0,
          'deleted space row still present in Settings -> Spaces',
        );
        await shot('11-spaces-after-delete');
      },
    );

    // ---------- Persistence across relaunch ----------
    await step(
      'relaunch-toggle-persistence',
      'Relaunch: Cool blue cast stays OFF (non-default); active vault + Notes intact',
      async () => {
        await session.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        await page.setViewportSize({ width: 1400, height: 900 });

        await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
        await shot('12-relaunch-home');

        await openSettingsPage('Appearance');
        const sw = page.getByRole('switch', { name: 'Cool blue cast' });
        await sw.waitFor({ state: 'visible', timeout: 10_000 });
        const checked = await sw.getAttribute('aria-checked');
        console.log(`[v2-02] Cool blue cast after relaunch: ${checked}`);
        assert(
          checked === 'false',
          `Cool blue cast OFF did not persist relaunch (aria-checked=${checked})`,
        );
        await shot('13-relaunch-cool-blue-cast-persisted');

        // Deleted space must not resurrect.
        await page.getByRole('button', { name: 'Spaces', exact: true }).click();
        await page.waitForTimeout(500);
        const spacesText = await page.locator('body').textContent();
        assert(!/QA Second Space/.test(spacesText), 'deleted space resurrected after relaunch');
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ VAULTS/SETTINGS VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('===============================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll vaults/settings steps PASSED.');
    }
  } finally {
    await session.close();
    await fs.rm(USER_DATA_DIR, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
