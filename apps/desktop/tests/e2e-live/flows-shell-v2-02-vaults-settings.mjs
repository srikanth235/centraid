#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#382) one continuous
// real-Electron user journey (space create/switch/rename/test-connection/
// delete + settings persistence across relaunch) sharing one page/session;
// splitting mid-journey would duplicate launch/teardown boilerplate for a
// ~68-line overage rather than improve legibility.
// Shell QA v2 Suite 2: Settings deep-walk beyond the v1 tab sweep, rewritten
// for issue #382's switcher/Settings redesign. Space (vault) lifecycle now
// lives ENTIRELY in the switcher popover — Settings -> Spaces (the old
// cross-vault list + "Add profile"/trash-icon UI) is deleted outright, per
// the design doc — plus the switcher's per-gateway overflow menu (Test
// connection… / Rename…). Settings -> Space (singular) only edits the
// ACTIVE vault; its "Delete this space" button is the only remaining delete
// path. Connections/Appearance/Layout persistence checks are unchanged
// (those pages didn't move).
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

/** The sidebar-head switcher trigger — its accessible name names the active
 *  space ("Active space: Owner's vault. Click to switch."), so this is
 *  robust to which vault happens to be active when it's called. */
function switcherHead() {
  return page.getByRole('button', { name: /Active space:/ });
}

async function openSwitcher() {
  await switcherHead().click();
  await page.getByRole('menu').first().waitFor({ state: 'visible', timeout: 5_000 });
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

    // ---------- Space: create via the switcher's "+New space" ----------
    await step(
      'space-create',
      'Switcher "+New space" -> SpaceModal -> create -> auto-switch -> Home is empty',
      async () => {
        await page.getByRole('button', { name: 'Home', exact: true }).first().click();
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await openSwitcher();
        await shot('06-spaces-before-add');
        // The header's "New space…" action, scoped to the local gateway
        // group (aria-label "New space on <gatewayLabel>" — see
        // vaultSwitcher.ts's buildGroup). A fresh profile's gateway label is
        // "Local".
        await page.getByRole('button', { name: 'New space on Local' }).click();
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

        // Creating auto-switches to the new vault and navigates Home
        // (spaceModals.ts's `createSpace` calls `setActiveVault` itself).
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
        assert(/QA Second Space/.test(bodyText), 'sidebar head does not show the new space name');
      },
    );

    // ---------- Settings -> Space: edit the ACTIVE vault, reflects in switcher ----------
    await step(
      'space-edit-persists',
      "Settings -> Space edits (name/color) save and reflect in the switcher's vault row",
      async () => {
        await openSettingsPage('Space');
        await page
          .getByRole('heading', { name: 'Space' })
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(400);
        const spaceBodyBefore = await page.locator('body').textContent();
        assert(
          /QA Second Space/.test(spaceBodyBefore),
          'Settings -> Space is not scoped to the active (new) space',
        );
        const nameInput = page.locator('input[type="text"]').first();
        await nameInput.fill('QA Renamed Space');
        // A color swatch other than whatever the space randomly started
        // with — SpaceModal.PROFILE_COLORS[2] renders as the 3rd swatch
        // button in the Color field.
        const colorButtons = page.locator('button[aria-label^="Color "]');
        await colorButtons.nth(2).click();
        const saveBtn = page.getByRole('button', { name: 'Save changes' });
        assert(
          !(await saveBtn.isDisabled()),
          'Save changes should be enabled once the form is dirty',
        );
        await saveBtn.click();
        await page.waitForTimeout(600);
        await shot('07b-settings-space-edited');

        // The sidebar head's own accessible name ("Active space: <name>. …")
        // must pick up the rename IMMEDIATELY — no switcher open, no vault
        // switch, no relaunch. saveSpace() only issued a direct HTTP
        // updateVault() call with no broadcast until the #382 follow-up fix
        // (notifyVaultMetadataChanged); before that fix this button kept
        // showing the pre-edit name here.
        const headNameAfterSave = await switcherHead().getAttribute('aria-label');
        assert(
          headNameAfterSave && /QA Renamed Space/.test(headNameAfterSave),
          `sidebar head did not pick up the rename without opening the switcher, got ${JSON.stringify(headNameAfterSave)}`,
        );
        assert(
          !/QA Second Space/.test(headNameAfterSave ?? ''),
          'sidebar head still shows the pre-edit name',
        );

        // Also reflects in the switcher's vault row (the switcher is the
        // pair manager now, not just a mirror of the head).
        await openSwitcher();
        const menu = page.getByRole('menu').first();
        const menuText = await menu.textContent();
        assert(
          /QA Renamed Space/.test(menuText),
          `switcher vault row did not pick up the Settings -> Space rename, got ${JSON.stringify(menuText)}`,
        );
        assert(
          !/QA Second Space/.test(menuText),
          'switcher vault row still shows the pre-edit name',
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // Rename it back to "QA Second Space" so the rest of the suite's
        // assertions (which key on that literal name) keep working. Still on
        // the Space page underneath (the switcher was an overlay) — no need
        // to re-navigate.
        await page.locator('input[type="text"]').first().fill('QA Second Space');
        await page.getByRole('button', { name: 'Save changes' }).click();
        await page.waitForTimeout(500);
      },
    );

    // ---------- Switch back via the switcher popover ----------
    await step(
      'space-switch-back',
      'Switcher lists both spaces (grouped under Local); switching back restores Notes',
      async () => {
        await openSwitcher();
        const menu = page.getByRole('menu').first();
        const menuText = await menu.textContent();
        console.log(`[v2-02] vault switcher menu: ${JSON.stringify(menuText)}`);
        assert(/Owner/.test(menuText), 'switcher does not list the primary vault');
        assert(/QA Second Space/.test(menuText), 'switcher does not list the new space');
        assert(/SPACES\s*·\s*2/.test(menuText), 'switcher eyebrow does not report 2 spaces total');
        await shot('08-vault-switcher-popover');
        await menu.getByRole('menuitem', { name: /Owner/ }).click();
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
        await shot('09-home-back-on-primary-vault');
      },
    );

    // ---------- Switcher overflow menu: Test connection… + Rename… ----------
    await step(
      'switcher-overflow-test-and-rename',
      'Overflow "More" menu: Test connection… passes all stages; Rename… relabels the gateway header',
      async () => {
        await openSwitcher();
        const moreBtn = page.getByRole('button', { name: 'More actions for Local' });
        await moreBtn.waitFor({ state: 'visible', timeout: 5_000 });
        await moreBtn.click();
        const overflowMenu = page.getByRole('menu').last();
        await overflowMenu.waitFor({ state: 'visible', timeout: 5_000 });
        await overflowMenu.getByRole('menuitem', { name: /Test connection/ }).click();
        const testDialog = page.getByRole('dialog').filter({ hasText: 'Test connection' });
        await testDialog.waitFor({ state: 'visible', timeout: 5_000 });
        await page.waitForTimeout(1_500);
        await shot('10-test-connection-local');
        const testText = await testDialog.textContent();
        console.log(`[v2-02] test-connection modal: ${JSON.stringify(testText)}`);
        assert(/Reach gateway/.test(testText), 'handshake ladder missing "Reach gateway" stage');
        assert(/List vaults/.test(testText), 'handshake ladder missing "List vaults" stage');
        await testDialog.getByRole('button', { name: 'Close', exact: true }).last().click();
        await page.waitForTimeout(300);

        await openSwitcher();
        await page.getByRole('button', { name: 'More actions for Local' }).click();
        const overflowMenu2 = page.getByRole('menu').last();
        await overflowMenu2.waitFor({ state: 'visible', timeout: 5_000 });
        await overflowMenu2.getByRole('menuitem', { name: /Rename/ }).click();
        const renameDialog = page.getByRole('dialog').filter({ hasText: 'Rename gateway' });
        await renameDialog.waitFor({ state: 'visible', timeout: 5_000 });
        const renameInput = renameDialog.locator('input[type="text"]').first();
        assert(
          (await renameInput.inputValue()) === 'Local',
          `rename field should prefill the gateway's current label "Local", got ${await renameInput.inputValue()}`,
        );
        await renameInput.fill('My Mac');
        await renameDialog.getByRole('button', { name: 'Save', exact: true }).click();
        await page.waitForTimeout(500);
        await shot('11-after-rename');

        await openSwitcher();
        const menuAfterRename = await page.getByRole('menu').first().textContent();
        assert(
          /My Mac/.test(menuAfterRename),
          `switcher header did not pick up the rename, got ${JSON.stringify(menuAfterRename)}`,
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      },
    );

    // ---------- Delete the second space via Settings -> Space ----------
    await step(
      'space-delete',
      'Switch to the second space, delete it from Settings -> Space, active vault falls back',
      async () => {
        await openSwitcher();
        const menu = page.getByRole('menu').first();
        await menu.getByRole('menuitem', { name: /QA Second Space/ }).click();
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForTimeout(500);

        await openSettingsPage('Space');
        await page
          .getByRole('heading', { name: 'Space' })
          .first()
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(400);
        await shot('12-settings-space-second');
        const spaceBody = await page.locator('body').textContent();
        assert(
          /QA Second Space/.test(spaceBody),
          "Settings -> Space does not show the active (second) space's name",
        );
        // Settings -> Space is scoped to the active vault ONLY — no
        // cross-vault list and no gateway "Connections" group left on it
        // (both moved to the switcher, issue #382).
        assert(
          !/Add profile/.test(spaceBody),
          'Settings -> Space still shows the deleted cross-vault "Add profile" affordance',
        );

        const delBtn = page.getByRole('button', { name: 'Delete this space' });
        await delBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await delBtn.click();
        const confirmDialog = page.getByRole('dialog', { name: 'Delete this space?' });
        await confirmDialog.waitFor({ state: 'visible', timeout: 5_000 });
        await shot('13-delete-space-confirm');
        // First: Cancel keeps it.
        await confirmDialog.getByRole('button', { name: 'Cancel' }).click();
        await confirmDialog.waitFor({ state: 'hidden', timeout: 5_000 });
        assert(
          (await page.getByRole('button', { name: 'Delete this space' }).count()) === 1,
          'space vanished after CANCEL',
        );
        // Then: confirm deletes it.
        await page.getByRole('button', { name: 'Delete this space' }).click();
        const confirm2 = page.getByRole('dialog', { name: 'Delete this space?' });
        await confirm2.waitFor({ state: 'visible', timeout: 5_000 });
        await confirm2.getByRole('button', { name: 'Delete', exact: true }).click();
        // Deleting the ACTIVE space navigates Home and the sidebar head must
        // fall back to the remaining vault ("Owner's vault") — this is the
        // real regression this rewrite caught: VAULTS_DELETE previously
        // never broadcast VAULT_CHANGED, so the shell kept showing the
        // just-deleted space until an unrelated event refreshed it. Fixed
        // in apps/desktop/src/main/ipc.ts (VAULTS_DELETE handler).
        await page
          .getByRole('heading', { name: 'What should we build?' })
          .waitFor({ state: 'visible', timeout: 20_000 });
        await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(300);
        await shot('14-spaces-after-delete');
        const headLabel = await switcherHead().getAttribute('aria-label');
        console.log(`[v2-02] switcher head after deleting active space: ${headLabel}`);
        assert(
          headLabel != null && /Owner/.test(headLabel) && !/QA Second Space/.test(headLabel),
          `sidebar head did not fall back to the remaining vault after deleting the active one, got ${JSON.stringify(headLabel)}`,
        );
        await openSwitcher();
        const menuAfterDelete = await page.getByRole('menu').first().textContent();
        assert(
          !/QA Second Space/.test(menuAfterDelete),
          'deleted space row still present in the switcher',
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      },
    );

    // ---------- Persistence across relaunch ----------
    await step(
      'relaunch-toggle-persistence',
      'Relaunch: Cool blue cast stays OFF (non-default); active vault + Notes + gateway rename intact',
      async () => {
        await session.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        await page.setViewportSize({ width: 1400, height: 900 });

        await page.locator('[data-app-id="notes"]').waitFor({ state: 'visible', timeout: 15_000 });
        await shot('15-relaunch-home');

        await openSettingsPage('Appearance');
        const sw = page.getByRole('switch', { name: 'Cool blue cast' });
        await sw.waitFor({ state: 'visible', timeout: 10_000 });
        const checked = await sw.getAttribute('aria-checked');
        console.log(`[v2-02] Cool blue cast after relaunch: ${checked}`);
        assert(
          checked === 'false',
          `Cool blue cast OFF did not persist relaunch (aria-checked=${checked})`,
        );
        await shot('16-relaunch-cool-blue-cast-persisted');

        // Deleted space must not resurrect, and the gateway rename ("My
        // Mac") must have persisted, in the switcher.
        await openSwitcher();
        const menuText = await page.getByRole('menu').first().textContent();
        assert(!/QA Second Space/.test(menuText), 'deleted space resurrected after relaunch');
        assert(/My Mac/.test(menuText), 'gateway rename did not persist across relaunch');
        await page.keyboard.press('Escape');
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
