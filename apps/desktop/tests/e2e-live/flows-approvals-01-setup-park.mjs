#!/usr/bin/env node
// Approvals QA Suite 1: fresh-vault empty state, Settings -> Connections walk,
// install Locker, observe ungranted UX, grant access, create 4 items
// (alpha/beta/gamma/delta secret), trash + two-click "Delete forever" each so
// all 4 park (purge-item has confirmation:"required" -> always parks for app
// callers). Leaves the parked state behind in a REUSED userDataDir for
// flows-approvals-02-decide-corner-cases.mjs to pick up.
//
// Run with: node apps/desktop/tests/e2e-live/flows-approvals-01-setup-park.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
export const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-approvals');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({
      text: msg.text(),
      type: msg.type(),
      frameUrl: msg.location()?.url ?? '',
    });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', frameUrl: '' });
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-appr1-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `appr1-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(page) {
  return page.frameLocator('iframe[data-centraid-app="1"]');
}

async function createLockerItem(fl, title) {
  await fl.locator('.v-newbtn').click();
  const modal = fl.locator('.kit-modal');
  await modal.waitFor({ state: 'visible', timeout: 5000 });
  await modal.locator('.v-in').first().fill(title);
  await modal.getByRole('button', { name: 'Save', exact: true }).click();
  await modal.waitFor({ state: 'hidden', timeout: 5000 });
}

async function trashLockerItem(fl, title) {
  await fl.locator('.v-item', { hasText: title }).click();
  const detail = fl.locator('.v-detail-inner');
  await detail.waitFor({ state: 'visible', timeout: 5000 });
  await detail.getByRole('button', { name: 'Move to trash' }).click();
  await fl.locator('.v-list').waitFor({ state: 'visible', timeout: 5000 });
}

// Trash nav -> open the row -> two-click "Delete forever" (arm + confirm).
// A mid-session fix (packages/vault/src/commands/locker.ts PURGE_ITEM now
// sets `confirm: true`) made this genuinely PARK for the app-kind caller
// instead of executing immediately -- see the FINDING trail in flow3c
// below for the original bug this replaced.
async function armAndConfirmDeleteForever(fl, title) {
  await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
  await fl.locator('.v-item', { hasText: title }).click();
  const detail = fl.locator('.v-detail-inner');
  await detail.waitFor({ state: 'visible', timeout: 8000 });
  const delBtn = detail.getByRole('button', { name: /Delete forever/ });
  await delBtn.click(); // arm
  await page.waitForTimeout(200);
  const armedText = await delBtn.textContent();
  assert(
    /sure\?/i.test(armedText ?? ''),
    `expected armed label "Delete forever — sure?", got ${armedText}`,
  );
  await delBtn.click(); // confirm -> purge-item (now parks)
  await page.waitForTimeout(700);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000); // heavy concurrent load on this shared dev box
  console.log(`[appr1] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---- Flow 1: fresh vault Approvals empty state ----
    await step(
      'flow1-empty-approvals',
      'Approvals: empty state + always-on Standing grants copy',
      async () => {
        await navTo(page, 'Approvals');
        await page
          .getByRole('heading', { name: 'Approvals', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        const emptyText = await page.locator('text=Nothing waiting on you.').textContent();
        assert(
          emptyText?.trim() === 'Nothing waiting on you.',
          `unexpected empty-state copy: ${emptyText}`,
        );
        const grantsEmpty = await page.locator('text=No standing grants yet').first().textContent();
        assert(
          /always allow/.test(grantsEmpty ?? ''),
          `unexpected grants-empty copy: ${grantsEmpty}`,
        );
        await shot('01-empty-approvals');
      },
    );

    // ---- Flow 8: Settings -> Connections walk ----
    await step(
      'flow8-settings-connections',
      'Settings -> Account -> Connections renders + Add connection wizard opens/cancels',
      async () => {
        // Sidebar "Settings" carries a trailing "live" status-pill, so its
        // accessible name is "Settings live" -- navTo()'s exact match won't
        // hit it; match by prefix instead.
        await page
          .getByRole('button', { name: /^Settings/ })
          .first()
          .click();
        await page.getByRole('button', { name: 'Connections', exact: true }).click();
        const subtitle = page.locator('text=Data sources the vault pulls from').first();
        await subtitle.waitFor({ state: 'visible', timeout: 10_000 });
        const subtitleText = await subtitle.textContent();
        assert(
          /Gmail/.test(subtitleText ?? '') && /GitHub/.test(subtitleText ?? ''),
          `unexpected Connections subtitle: ${subtitleText}`,
        );
        await shot('02-settings-connections');

        const addBtn = page.getByRole('button', { name: 'Add connection' });
        await addBtn.click();
        const providerLabel = page.locator('text=Provider').first();
        await providerLabel.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
        await shot('02-settings-connections-wizard-open');

        const cancelBtn = page.getByRole('button', { name: 'Cancel', exact: true });
        if (await cancelBtn.count()) {
          await cancelBtn.click();
          await page.waitForTimeout(200);
          await shot('02-settings-connections-wizard-cancelled');
        }
      },
    );

    // ---- Flow 2: install Locker, observe ungranted UX ----
    await step(
      'flow2a-install-locker',
      'Discover -> preview Locker -> Use this template',
      async () => {
        await navTo(page, 'Discover');
        const lockerCard = page.locator('button[data-kind="app"]', { hasText: 'Locker' }).first();
        await lockerCard.waitFor({ state: 'visible', timeout: 20_000 });
        await lockerCard.click();
        const dialog = page.getByRole('dialog', { name: /^Preview Locker/ });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: 'Use this template' }).click();
        const toast = page.locator('[data-global-toast]');
        await toast.waitFor({ state: 'visible', timeout: 10_000 });
        const toastText = await toast.textContent();
        assert(
          /Installed "Locker"/.test(toastText ?? ''),
          `unexpected install toast: ${toastText}`,
        );
        const tile = page.locator('[data-app-id="locker"]');
        await tile.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('03-home-with-locker-tile');
      },
    );

    let observedUngranted = null; // filled in by flow2b for the final report
    await step(
      'flow2b-ungranted-behavior',
      'Open Locker right after install -> observe actual ungranted/granted UX (no assertion, this IS the observation)',
      async () => {
        const tile = page.locator('[data-app-id="locker"]');
        await tile.getByTestId('app-tile').click();
        await page.waitForSelector('iframe[data-centraid-app="1"]', {
          state: 'attached',
          timeout: 20_000,
        });
        const fl = frameLoc(page);
        await page.waitForTimeout(1000); // let the initial items query resolve either way
        const consentBanner = fl.locator('#consentBanner');
        const consentVisible = await consentBanner.isVisible().catch(() => false);
        const newItemBtnCount = await fl.locator('.v-newbtn').count();
        observedUngranted = { consentVisible, newItemBtnCount };
        console.log(
          `[appr1] OBSERVED post-install state: consentBanner visible=${consentVisible}, .v-newbtn count=${newItemBtnCount}`,
        );
        await shot('04-locker-post-install-state');
      },
    );

    await step(
      'flow2c-grant-access',
      'Gear -> App settings -> Vault tab -> Grant access (skips if already granted)',
      async () => {
        await page.locator('button[aria-label="App settings"]').click();
        const dialog = page.getByRole('dialog', { name: 'App settings' });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('05-app-settings-appearance-tab');
        await dialog.getByRole('button', { name: 'Vault' }).click();
        await page.waitForTimeout(400);
        await shot('06-app-settings-vault-tab-initial');

        const grantBtn = dialog.getByRole('button', { name: 'Grant access' });
        const alreadyGranted = (await grantBtn.count()) === 0;
        console.log(
          `[appr1] Vault tab already shows a grant (no "Grant access" button): ${alreadyGranted}`,
        );
        if (!alreadyGranted) {
          await grantBtn.click();
          // Granting reloads the app iframe (onAccessChanged -> reloadAppFrame).
          await page.waitForTimeout(1500);
          await shot('07-app-settings-vault-tab-granted');
        }
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        const fl = frameLoc(page);
        await fl.locator('.v-newbtn').waitFor({ state: 'visible', timeout: 15_000 });
        const consentBannerHidden = await fl
          .locator('#consentBanner')
          .isHidden()
          .catch(() => true);
        assert(consentBannerHidden, 'consent banner should be hidden once access is granted');
        await shot('08-locker-granted-chrome-visible');
      },
    );

    // ---- Flow 3 (part 1): create 4 items ----
    const ITEM_TITLES = ['alpha secret', 'beta secret', 'gamma secret', 'delta secret'];
    await step('flow3a-create-items', 'Create 4 Locker items via its own UI form', async () => {
      const fl = frameLoc(page);
      for (const title of ITEM_TITLES) {
        await createLockerItem(fl, title);
        await page.waitForTimeout(300);
      }
      await fl.locator('button.v-nav-item', { hasText: 'All items' }).click();
      await page.waitForTimeout(300);
      await shot('09-locker-4-items-created');
      for (const title of ITEM_TITLES) {
        const count = await fl.locator('.v-item', { hasText: title }).count();
        assert(count >= 1, `item "${title}" not found in list after creation`);
      }
    });

    await step('flow3b-trash-4-items', 'Move all 4 items to trash', async () => {
      const fl = frameLoc(page);
      for (const title of ITEM_TITLES) {
        await trashLockerItem(fl, title);
        await page.waitForTimeout(250);
      }
      await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
      await page.waitForTimeout(300);
      await shot('10-locker-trash-4-items');
      for (const title of ITEM_TITLES) {
        const count = await fl.locator('.v-item', { hasText: title }).count();
        assert(count === 1, `expected "${title}" in trash exactly once, got ${count}`);
      }
    });

    // *** MAJOR FINDING (see final report + spawned follow-up task) ***
    // purge-item declares `"confirmation": "required"` in app.json, and the
    // brief's premise was that this makes the vault PARK the write for
    // owner review. Root-caused by source inspection: the vault gateway
    // only parks a command when its CommandDefinition sets `confirm: true`
    // (packages/vault/src/gateway/gateway.ts:637-669) -- app.json's
    // "confirmation" field is a separate, client-side-only concept the
    // dispatcher never reads (packages/app-engine/.../manifest.ts:76-79).
    // `PURGE_ITEM` in packages/vault/src/commands/locker.ts has no
    // `confirm: true` (deliberately, per its own inline comment -- it rides
    // the app's own two-click UI instead). Net effect: Delete-forever
    // executed for real, immediately, with NO server-side parking. Root
    // cause: packages/vault/src/commands/locker.ts PURGE_ITEM had no
    // `confirm: true`. FIXED mid-session (concurrent worktree edit, landed
    // via the follow-up task this run spawned) -- rebuilt dist now parks
    // for every non-owner-device caller, matching app.json's
    // "confirmation":"required". These steps now exercise the REAL,
    // FIXED parking path end to end.
    const ITEM_TITLES_ALL = ITEM_TITLES; // alpha/beta/gamma/delta secret
    await step(
      'flow3c-delete-forever-now-parks',
      'Two-click "Delete forever" on all 4 items -> each now PARKS (confirm:true fix)',
      async () => {
        const fl = frameLoc(page);
        for (const title of ITEM_TITLES_ALL) {
          await armAndConfirmDeleteForever(fl, title);
          const noticeText = await fl
            .locator('#noticeBanner')
            .textContent()
            .catch(() => '');
          console.log(
            `[appr1] notice after Delete-forever confirm on "${title}": ${JSON.stringify(noticeText)}`,
          );
          assert(
            /Waiting for your approval/.test(noticeText ?? ''),
            `expected parked-notice copy for "${title}", got: ${noticeText}`,
          );
        }
        await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(300);
        await shot('11-locker-trash-all-4-parked-still-present');
        // All 4 must still be IN TRASH -- parked means not yet executed.
        for (const title of ITEM_TITLES_ALL) {
          const count = await fl.locator('.v-item', { hasText: title }).count();
          assert(
            count === 1,
            `expected "${title}" to remain in trash (parked, not executed), got ${count}`,
          );
        }
      },
    );

    await step(
      'flow3d-locker-vaulttab-4-waiting',
      'Locker Vault tab "Waiting for your say-so" shows all 4 parked purge_item entries',
      async () => {
        try {
          await page.locator('button[aria-label="App settings"]').click();
          const dialog = page.getByRole('dialog', { name: 'App settings' });
          await dialog.waitFor({ state: 'visible', timeout: 10_000 });
          await dialog.getByRole('button', { name: 'Vault' }).click();
          await page.waitForTimeout(500);
          await shot('12-locker-vaulttab-4-waiting');
          const waitingLabel = dialog.locator('text=Waiting for your say-so');
          await waitingLabel.waitFor({ state: 'visible', timeout: 10_000 });
          // Scope the count to the "Waiting for your say-so" section itself --
          // "locker.purge_item" also appears twice elsewhere in this panel (the
          // "Requested access" scope chip and the "Access · owner's vault"
          // granted-scopes list), so an unscoped dialog-wide count over-matches.
          const section = waitingLabel.locator('xpath=..');
          const parkedCommandCount = await section.locator('text=locker.purge_item').count();
          console.log(`[appr1] Vault-tab "Waiting for your say-so" entries: ${parkedCommandCount}`);
          const vaultTabBadge = await dialog.getByRole('button', { name: /^Vault/ }).textContent();
          console.log(`[appr1] Vault tab badge text: ${JSON.stringify(vaultTabBadge)}`);
          assert(
            parkedCommandCount === 4,
            `expected 4 parked entries in app Vault tab, got ${parkedCommandCount}`,
          );
        } finally {
          // Always close the popover, even on assertion failure -- otherwise
          // its backdrop intercepts every subsequent click (cascading failure).
          await page.keyboard.press('Escape').catch(() => undefined);
          await page.waitForTimeout(300);
        }
      },
    );

    await step(
      'flow3e-approvals-parked-group-4-rows',
      'Approvals screen shows a Parked group with all 4 rows',
      async () => {
        // navTo()'s exact-match doesn't fit here: the sidebar badge now
        // appends the blocking count straight into the button's accessible
        // name ("Approvals4", no separator -- see Sidebar.tsx SbItem's
        // `{props.meta}` span), so match by prefix instead.
        await page
          .getByRole('button', { name: /^Approvals/ })
          .first()
          .click();
        await page
          .getByRole('heading', { name: 'Approvals', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        const parkedHead = page.locator('h2', { hasText: 'Parked' });
        await parkedHead.waitFor({ state: 'visible', timeout: 10_000 });
        await shot('13-approvals-parked-4-rows');
        const rows = page.locator('text=locker.purge_item');
        const rowCount = await rows.count();
        console.log(`[appr1] Approvals Parked rows showing "locker.purge_item": ${rowCount}`);
        assert(rowCount === 4, `expected 4 parked rows on Approvals, got ${rowCount}`);
        const emptyStillThere = await page.locator('text=Nothing waiting on you.').count();
        assert(
          emptyStillThere === 0,
          'empty-state copy should be gone now that something is waiting',
        );
      },
    );

    await step(
      'flow3f-sidebar-badge-after-focus',
      'Sidebar Approvals badge shows 4 after a window focus event (may lag up to 60s otherwise)',
      async () => {
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForTimeout(600);
        const btn = page.getByRole('button', { name: /Approvals/ });
        const text = await btn.textContent();
        console.log(`[appr1] sidebar Approvals button text after focus: ${JSON.stringify(text)}`);
        assert(
          text?.trim() === 'Approvals4',
          `expected badge "4" appended after focus refresh, got ${JSON.stringify(text)}`,
        );
        await shot('14-sidebar-badge-4-after-focus');
      },
    );

    await step(
      'flow3g-approvals-expand-json-preview',
      'Expand one Parked row -> raw JSON input preview visible',
      async () => {
        // ApprovalsScreen.module.css classes are hashed (CSS modules) -- can't
        // select by literal `.row`. ParkedRow's whole toggle surface is a
        // <button> containing the command text; click that directly.
        const rowToggle = page.locator('button', { hasText: 'locker.purge_item' }).first();
        await rowToggle.click();
        await page.waitForTimeout(300);
        const pre = page.locator('pre').first();
        const preText = await pre.textContent().catch(() => '');
        console.log(`[appr1] expanded parked row JSON preview: ${preText}`);
        assert(
          /item_id/.test(preText ?? ''),
          `expected item_id in the raw input preview, got: ${preText}`,
        );
        await shot('15-approvals-parked-row-expanded-json');
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ APPROVALS SUITE 1 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('===================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log(`\nuserDataDir preserved for suite 2: ${USER_DATA_DIR}`);
    console.log(
      `Observed post-install ungranted/granted state: ${JSON.stringify(observedUngranted)}`,
    );

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll approvals-suite-1 steps PASSED.');
    }
  } finally {
    await session.close();
    // NOTE: userDataDir intentionally NOT removed -- suite 2 reuses it.
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
