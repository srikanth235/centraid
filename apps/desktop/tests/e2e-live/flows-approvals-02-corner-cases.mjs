#!/usr/bin/env node
// governance: allow-repo-hygiene file-size-limit (#363) single coherent multi-step live-app QA scenario against the real Electron+gateway rig; splitting mid-scenario would fragment one flow across files with no readability gain
// Approvals QA Suite 2: approve/deny/cross-surface/badge-lag/stale-decision/
// relaunch-persistence corner cases, exercised against REAL parked
// invocations now that packages/vault/src/commands/locker.ts PURGE_ITEM
// sets `confirm: true` (mid-session fix -- see suite 1's flow3c-g for the
// original bug and its resolution).
//
// SELF-CONTAINED (does its own install/grant/create/trash/park setup) --
// an earlier version tried to reuse suite 1's leftover userDataDir, but
// that doesn't work: the vault's parked-invocation queue lives ONLY in the
// gateway's in-memory Map (packages/vault/src/gateway/gateway.ts:113,
// `private readonly parked = new Map(...)`, never persisted/hydrated), so
// it's gone the instant suite 1's Electron process exits -- confirmed
// empirically (a fresh launch against suite 1's on-disk vault showed 0
// parked rows even though the underlying Locker items were still there).
// That's itself a real finding, folded into flow7b below via an explicit,
// intentional close+relaunch instead of an accidental one.
//
// Run with: node apps/desktop/tests/e2e-live/flows-approvals-02-corner-cases.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-approvals-suite2');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-appr2-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `appr2-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

async function openLocker(p) {
  // `[data-app-id="locker"]` only exists on Home's app-grid card
  // (HomeScreen.tsx AppCard) -- it's absent everywhere else, including the
  // Approvals screen most flows call this from. The persistent left-rail
  // "APPS" sidebar entry (Sidebar.tsx SbItem, a plain named <button>) is
  // the one surface present on every screen; use that instead.
  const sidebarItem = p.getByRole('button', { name: 'Locker', exact: true }).first();
  await sidebarItem.waitFor({ state: 'visible', timeout: 15_000 });
  await sidebarItem.click();
  await p.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
  const fl = frameLoc(p);
  await fl.locator('.v-newbtn').waitFor({ state: 'visible', timeout: 15_000 });
  return fl;
}

async function goApprovals(p) {
  // Sidebar badge appends straight into the accessible name ("Approvals4",
  // no separator) so exact match breaks whenever something is blocking.
  await p
    .getByRole('button', { name: /^Approvals/ })
    .first()
    .click();
  await p
    .getByRole('heading', { name: 'Approvals', level: 1 })
    .waitFor({ state: 'visible', timeout: 10_000 });
}

/** ParkedRow's whole toggle surface is a <button> containing the command
 *  text -- CSS-module classes are hashed, so select by text instead. */
function parkedRowToggle(p, nth = 0) {
  return p.locator('button', { hasText: 'locker.purge_item' }).nth(nth);
}

async function createTrashParkLockerItem(fl, title) {
  // The previous call in a loop leaves the app on the Trash tab (we end
  // there to click "Delete forever") -- a fresh item created while that
  // tab is selected won't appear in the (Trash-filtered) list this
  // function immediately searches, since it isn't trashed yet. Land back
  // on "All items" first so `.v-newbtn` + the item-list click both target
  // the right view. (All items nav may not exist pre-first-item; ignore.)
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
  await fl.locator('.v-item', { hasText: title }).click();
  await detail.waitFor({ state: 'visible', timeout: 8000 });
  const delBtn = detail.getByRole('button', { name: /Delete forever/ });
  await delBtn.click();
  await page.waitForTimeout(200);
  await delBtn.click();
  await page.waitForTimeout(700);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[appr2] launched (fresh vault) + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    // ---- Setup: install Locker, grant access, park 4 items (mirrors
    // suite 1's flow2/flow3, kept self-contained here per the header note
    // above -- parked state can't be carried over from a separate process). ----
    await step(
      'setup-install-grant-park-4',
      'Install Locker, grant access, create+trash+park 4 items',
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
        const fl = await openLocker(page);
        // Installing via Discover auto-grants (issue #306 decision 2 -- see
        // suite 1's flow2 finding); confirm no consent banner is blocking.
        const consentVisible = await fl
          .locator('#consentBanner')
          .isVisible()
          .catch(() => false);
        console.log(`[appr2] Locker consent banner visible after install: ${consentVisible}`);
        for (const title of ['alpha secret', 'beta secret', 'gamma secret', 'delta secret']) {
          await createTrashParkLockerItem(fl, title);
        }
        await goApprovals(page);
        const parkedCount = await page.locator('button', { hasText: 'locker.purge_item' }).count();
        console.log(`[appr2] parked rows after setup: ${parkedCount}`);
        assert(parkedCount === 4, `expected 4 parked rows after setup, got ${parkedCount}`);
        await shot('00-setup-4-parked');
      },
    );

    // ---- Flow 4: Approve "alpha secret" from Approvals ----
    await step(
      'flow4-approve-from-approvals',
      'Approve one Parked row from Approvals -> row gone, item actually purged in Locker',
      async () => {
        await goApprovals(page);
        const before = await page.locator('button', { hasText: 'locker.purge_item' }).count();
        console.log(`[appr2] Parked rows before approve: ${before}`);
        await parkedRowToggle(page, 0).click(); // expand the first row (alpha, oldest)
        await page.waitForTimeout(200);
        const pre = page.locator('pre').first();
        const preText = await pre.textContent();
        const itemIdMatch = /"item_id":\s*"([^"]+)"/.exec(preText ?? '');
        console.log(`[appr2] expanded row item_id: ${itemIdMatch?.[1]}`);
        await shot('01-approvals-before-approve');
        await page.getByRole('button', { name: 'Approve', exact: true }).click();
        await page.waitForTimeout(600);
        const after = await page.locator('button', { hasText: 'locker.purge_item' }).count();
        console.log(`[appr2] Parked rows after approve: ${after}`);
        assert(
          after === before - 1,
          `expected row count to drop by 1 after approve, ${before} -> ${after}`,
        );
        await shot('02-approvals-after-approve');

        // Verify the underlying item is REALLY gone from Locker's trash.
        const fl = await openLocker(page);
        await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(300);
        const alphaCount = await fl.locator('.v-item', { hasText: 'alpha secret' }).count();
        console.log(`[appr2] "alpha secret" still in Locker trash after Approve: ${alphaCount}`);
        assert(
          alphaCount === 0,
          `expected "alpha secret" to be actually purged after Approve, found ${alphaCount}`,
        );
        await shot('03-locker-trash-alpha-gone');
      },
    );

    // ---- Flow 5: Deny "beta secret" from Approvals -> danger confirm overlay ----
    await step(
      'flow5-deny-from-approvals',
      'Deny a Parked row -> danger confirm overlay -> confirm -> row gone, item SURVIVES (deny != delete)',
      async () => {
        await goApprovals(page);
        const before = await page.locator('button', { hasText: 'locker.purge_item' }).count();
        await parkedRowToggle(page, 0).click();
        await page.waitForTimeout(200);
        await page.getByRole('button', { name: 'Deny', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Deny this request?' });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        const dialogText = await dialog.textContent();
        console.log(`[appr2] deny confirm overlay copy: ${JSON.stringify(dialogText)}`);
        assert(
          /can.t be replayed/.test(dialogText ?? ''),
          `unexpected deny-overlay copy: ${dialogText}`,
        );
        await shot('04-deny-confirm-overlay');
        await dialog.getByRole('button', { name: 'Deny', exact: true }).click();
        await page.waitForTimeout(600);
        const after = await page.locator('button', { hasText: 'locker.purge_item' }).count();
        console.log(`[appr2] Parked rows after deny: ${before} -> ${after}`);
        assert(
          after === before - 1,
          `expected row count to drop by 1 after deny, ${before} -> ${after}`,
        );
        await shot('05-approvals-after-deny');

        // The item must NOT have been deleted -- deny just discards the ask.
        const fl = await openLocker(page);
        await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(300);
        const betaCount = await fl.locator('.v-item', { hasText: 'beta secret' }).count();
        console.log(`[appr2] "beta secret" still in Locker trash after Deny: ${betaCount}`);
        assert(
          betaCount === 1,
          `expected "beta secret" to SURVIVE a deny (still in trash), found ${betaCount}`,
        );
        await shot('06-locker-trash-beta-survives');
      },
    );

    // ---- Flow 6: approve "gamma secret" from the APP's own Vault-tab
    // surface instead of Approvals; verify cross-surface consistency AND
    // the badge-lag: the sidebar badge should NOT update until a focus
    // event, since only Approvals' own decisions trigger its immediate
    // reload (issue #306 decision 5 -- see useBlockingCount.ts). ----
    await step(
      'flow6-cross-surface-approve-from-app',
      'Approve from the app Vault tab -> Approvals no longer lists it; badge lags until focus',
      async () => {
        await openLocker(page);
        const badgeBeforeText = await page
          .getByRole('button', { name: /^Approvals/ })
          .first()
          .textContent();
        console.log(
          `[appr2] sidebar badge BEFORE app-surface decision (stale, pre-focus): ${JSON.stringify(badgeBeforeText)}`,
        );

        await page.locator('button[aria-label="App settings"]').click();
        const dialog = page.getByRole('dialog', { name: 'App settings' });
        await dialog.waitFor({ state: 'visible', timeout: 10_000 });
        await dialog.getByRole('button', { name: /^Vault/ }).click();
        await page.waitForTimeout(400);
        await shot('07-locker-vaulttab-before-app-approve');
        const gammaCard = dialog
          .locator('div', { has: page.getByText('locker.purge_item') })
          .first();
        void gammaCard;
        await dialog.getByRole('button', { name: 'Approve', exact: true }).first().click();
        await page.waitForTimeout(700);
        await shot('08-locker-vaulttab-after-app-approve');
        const waitingLeft = await dialog.locator('text=Waiting for your say-so').count();
        console.log(
          `[appr2] Vault-tab "Waiting for your say-so" section present after approving last-but-one: ${waitingLeft}`,
        );
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);

        // Cross-surface consistency: Approvals must also have dropped it.
        await goApprovals(page);
        const remaining = await page.locator('button', { hasText: 'locker.purge_item' }).count();
        console.log(`[appr2] Approvals Parked rows after app-surface approve: ${remaining}`);
        assert(remaining === 1, `expected exactly 1 parked row left (delta), got ${remaining}`);
        await shot('09-approvals-after-cross-surface-approve');

        // Badge lag: the sidebar hasn't refetched yet (no focus event fired),
        // so it should still show the STALE count from before this decision.
        const badgeStaleText = await page
          .getByRole('button', { name: /^Approvals/ })
          .first()
          .textContent();
        console.log(
          `[appr2] sidebar badge immediately after app-surface decision (expect STALE, no focus yet): ${JSON.stringify(badgeStaleText)}`,
        );
        // Then trigger the focus refresh and confirm it catches up.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForTimeout(600);
        const badgeFreshText = await page
          .getByRole('button', { name: /^Approvals/ })
          .first()
          .textContent();
        console.log(`[appr2] sidebar badge AFTER focus event: ${JSON.stringify(badgeFreshText)}`);
        assert(
          badgeFreshText?.trim() === 'Approvals1',
          `expected badge to read "Approvals1" after focus catch-up, got ${JSON.stringify(badgeFreshText)}`,
        );
        await shot('10-sidebar-badge-caught-up-after-focus');

        // Verify gamma is truly purged in Locker. `fl` was captured before
        // the goApprovals() navigation above, which unmounts Locker's
        // AppViewRoute (and its iframe) -- re-open it instead of reusing
        // the now-detached frame reference.
        const fl2 = await openLocker(page);
        await fl2.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(300);
        const gammaCount = await fl2.locator('.v-item', { hasText: 'gamma secret' }).count();
        assert(
          gammaCount === 0,
          `expected "gamma secret" purged after app-surface approve, found ${gammaCount}`,
        );
      },
    );

    // ---- Flow 7a: rapid double-click Approve on the last row (delta) --
    // no crash, no double-execution error. ----
    await step(
      'flow7a-rapid-double-click-approve',
      'Rapid double-click Approve on a real Parked row -> no crash, no double-execution error',
      async () => {
        await goApprovals(page);
        await parkedRowToggle(page, 0).click();
        await page.waitForTimeout(200);
        const approveBtn = page.getByRole('button', { name: 'Approve', exact: true });
        await Promise.all([approveBtn.click(), approveBtn.click().catch(() => undefined)]);
        await page.waitForTimeout(800);
        await shot('11-after-rapid-double-approve');
        const remaining = await page.locator('button', { hasText: 'locker.purge_item' }).count();
        console.log(`[appr2] Parked rows after rapid double-click approve: ${remaining}`);
        assert(remaining === 0, `expected 0 parked rows left (delta approved), got ${remaining}`);
        const emptyVisible = await page
          .locator('text=Nothing waiting on you.')
          .isVisible()
          .catch(() => false);
        assert(emptyVisible, 'expected Approvals empty state back after all 4 items decided');
        const errorsSoFar = consoleMessages.filter((m) => m.type === 'error');
        assert(
          errorsSoFar.length === 0,
          `expected no console errors from rapid double-click approve, got: ${JSON.stringify(errorsSoFar)}`,
        );
        await shot('12-approvals-empty-again');
      },
    );

    // ---- Flow 7d: repeated expand/collapse on a real Parked row, layout
    // stable, no crash. Also sets up "epsilon secret" parked for 7b. ----
    await step(
      'flow7d-repeated-expand-collapse-real-row',
      'Park a 5th item, expand/collapse its Approvals row repeatedly -> stable, no console errors',
      async () => {
        const fl = await openLocker(page); // flow7a left us on Approvals, not Locker's app view
        await createTrashParkLockerItem(fl, 'epsilon secret');
        await goApprovals(page);
        const row = parkedRowToggle(page, 0);
        for (let i = 0; i < 4; i++) {
          await row.click(); // expand
          await page.waitForTimeout(120);
          await row.click(); // collapse
          await page.waitForTimeout(120);
        }
        await row.click(); // leave expanded for the screenshot
        await page.waitForTimeout(150);
        await shot('13-epsilon-parked-row-after-thrash');
        const errorsSoFar = consoleMessages.filter((m) => m.type === 'error');
        assert(
          errorsSoFar.length === 0,
          `expected no console errors from expand/collapse thrash, got: ${JSON.stringify(errorsSoFar)}`,
        );
      },
    );

    // ---- Flow 7b: relaunch persistence. Prediction from source review
    // (packages/vault/src/gateway/gateway.ts:113 `private readonly parked =
    // new Map<...>()`, never persisted/hydrated): the parked queue is
    // in-memory only and will NOT survive a relaunch, even though the
    // underlying Locker item data (DB-backed) will. ----
    await step(
      'flow7b-relaunch-persistence',
      'Relaunch (same userDataDir): does the parked "epsilon secret" invocation survive?',
      async () => {
        await session.close();
        await new Promise((resolve) => setTimeout(resolve, 500));
        session = await launchApp({ userDataDir: USER_DATA_DIR });
        page = session.page;
        wireConsole(page);
        page.setDefaultTimeout(60_000);
        await page.setViewportSize({ width: 1400, height: 900 });
        await shot('14-relaunch-home');

        await goApprovals(page);
        const parkedAfterRelaunch = await page
          .locator('button', { hasText: 'locker.purge_item' })
          .count();
        const emptyAfterRelaunch = await page
          .locator('text=Nothing waiting on you.')
          .isVisible()
          .catch(() => false);
        console.log(
          `[appr2] FINDING: parked rows visible after relaunch: ${parkedAfterRelaunch} (empty-state visible: ${emptyAfterRelaunch})`,
        );
        await shot('15-relaunch-approvals-state');

        // Durable data check either way: "epsilon secret" itself (the Locker
        // item row, DB-backed) must still be in trash regardless of whether
        // the PARKED INVOCATION survived.
        const fl = await openLocker(page);
        await fl.locator('button.v-nav-item', { hasText: 'Trash' }).click();
        await page.waitForTimeout(300);
        const epsilonCount = await fl.locator('.v-item', { hasText: 'epsilon secret' }).count();
        console.log(
          `[appr2] "epsilon secret" item itself survived relaunch (durable data): ${epsilonCount === 1}`,
        );
        assert(
          epsilonCount === 1,
          `expected "epsilon secret" to still be in trash after relaunch, got ${epsilonCount}`,
        );
        await shot('16-relaunch-locker-trash-epsilon-present');
      },
    );

    // ---- Flow 7c: stale-decision handling. Park a 6th item, expand its
    // Approvals row (stale UI state), decide it via a raw gateway call
    // (simulating a decision landing from elsewhere -- e.g. another
    // device/session -- while this Approvals view still shows it), then
    // click the now-stale Approve button and confirm graceful handling. ----
    await step(
      'flow7c-stale-decision-after-decided-elsewhere',
      'Decide a parked item out-of-band, then click its now-stale Approve -> graceful, not a crash',
      async () => {
        const fl = await openLocker(page);
        await createTrashParkLockerItem(fl, 'zeta secret');
        await goApprovals(page);
        const row = parkedRowToggle(page, 0);
        await row.click();
        await page.waitForTimeout(200);
        const preText = await page.locator('pre').first().textContent();
        const itemId = /"item_id":\s*"([^"]+)"/.exec(preText ?? '')?.[1];
        console.log(`[appr2] zeta secret's purge_item item_id: ${itemId}`);
        assert(
          Boolean(itemId),
          'could not read item_id from the expanded row to correlate the invocation',
        );

        // Decide it out-of-band: same real gateway, same auth the renderer
        // already holds (window.CentraidApi.getGatewayAuth()) -- fetch the
        // blocking list to find the matching invocationId, then POST the
        // decision directly, bypassing this Approvals view entirely.
        const outcome = await page.evaluate(async (targetItemId) => {
          const auth = await window.CentraidApi.getGatewayAuth();
          const headers = { 'content-type': 'application/json' };
          if (auth.token) headers.authorization = `Bearer ${auth.token}`;
          if (auth.vaultId) headers['x-centraid-vault'] = auth.vaultId;
          const blockingRes = await fetch(`${auth.baseUrl}/centraid/_vault/blocking`, { headers });
          const blocking = await blockingRes.json();
          const match = (blocking.parked ?? []).find((p) =>
            JSON.stringify(p.input ?? {}).includes(targetItemId),
          );
          if (!match) return { error: 'no matching parked invocation found', blocking };
          const decideRes = await fetch(
            `${auth.baseUrl}/centraid/_vault/parked/${match.invocationId}`,
            { method: 'POST', headers, body: JSON.stringify({ approve: true }) },
          );
          return {
            status: decideRes.status,
            body: await decideRes.json().catch(() => null),
            invocationId: match.invocationId,
          };
        }, itemId);
        console.log(`[appr2] out-of-band decision result: ${JSON.stringify(outcome)}`);
        assert(
          !outcome.error,
          `failed to correlate/decide zeta out-of-band: ${JSON.stringify(outcome)}`,
        );
        // The gateway response body IS the ground truth that the purge
        // executed ({"status":"executed",...}) -- a separate UI-based Trash
        // check would require navigating to Locker, which unmounts this
        // still-stale Approvals view and defeats the rest of this flow (it
        // needs to stay un-refetched to test the stale-button click below).
        assert(
          outcome.body?.status === 'executed',
          `expected the out-of-band decision to execute, got ${JSON.stringify(outcome.body)}`,
        );

        // Now click the STALE Approve button still rendered in this
        // Approvals view (it never refetched since we expanded the row).
        const staleApprove = page.getByRole('button', { name: 'Approve', exact: true });
        const staleApproveVisible = await staleApprove.isVisible().catch(() => false);
        console.log(
          `[appr2] stale Approve button still visible in this view: ${staleApproveVisible}`,
        );
        if (staleApproveVisible) {
          await staleApprove.click();
          await page.waitForTimeout(700);
          await shot('17-after-clicking-stale-approve');
          const toastText = await page
            .locator('[data-global-toast]')
            .textContent()
            .catch(() => null);
          console.log(
            `[appr2] toast/error copy after clicking the stale Approve: ${JSON.stringify(toastText)}`,
          );
          const crashed = await page.evaluate(() => document.title).catch(() => null);
          assert(
            crashed !== null,
            'page appears to have crashed after clicking a stale Approve button',
          );
        }
        const errorsSoFar = consoleMessages.filter((m) => m.type === 'error');
        console.log(
          `[appr2] console errors after stale-decision corner case: ${JSON.stringify(errorsSoFar)}`,
        );
      },
    );

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ APPROVALS SUITE 2 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('===================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll approvals-suite-2 steps PASSED.');
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
