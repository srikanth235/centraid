#!/usr/bin/env node
// Apps v2 QA — Tally. Regular flow: install, welcome/empty dashboard,
// add-expense blocked without a group, add friend, create group, add an
// equal-split expense (verify derived balances against hand-computed math),
// second expense paid by the friend, expense detail modal, edit expense
// (exact split), delete expense, settle up, activity view, search. Corner
// cases: zero amount disables Save, odd-cent equal split (10.01 / 2),
// large amount (999999.99), decimal precision.
//
// Balance math (computed by hand, asserted against the UI):
//   E1: You paid $60.00, split equally You+Bob -> Bob owes you $30.00.
//   E2: Bob paid $10.01, split equally -> your share is $5.00 or $5.01
//       (rounding: per = round(1001/2) = 501 -> You借 $5.01, Bob keeps 500).
//       resolveSplits assigns per=501 to first member, remainder 500 to last.
//       Either way total net = 3000 - your_share.
//   After deleting E2: net back to +$30.00.
//   Settle: Bob pays you $30.00 -> all settled, dashboard shows $0.00s.
//
// Run with: node apps/desktop/tests/e2e-live/flows-apps-v2-tally.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'apps-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-apps-v2-tally');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// The vault's base currency is locale-dependent (INR on this machine — see
// packages/vault/src/bootstrap.ts `baseCurrency ?? 'INR'`), and grouping
// differs per locale (9,99,999.99 vs 999,999.99) — so strip currency symbols
// and group separators before matching amounts.
function norm(text) {
  return String(text ?? '').replace(/[,\u00A0]/g, '');
}

const results = [];
let page;
let currentStep = 'boot';
const consoleMessages = [];
function wireConsole(p) {
  p.on('console', (msg) => consoleMessages.push({ text: msg.text(), type: msg.type(), step: currentStep }));
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', step: currentStep });
    console.error(`[console][during ${currentStep}] pageerror: ${err}`);
  });
}

let shotN = 0;
async function shot(name) {
  shotN += 1;
  const p = path.join(OUT_DIR, `tally-${String(shotN).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function step(id, label, fn) {
  const t0 = Date.now();
  currentStep = id;
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `tally-FAILURE-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function installTally() {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: 'Tally' }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: /^Preview Tally/ });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  await page.locator('[data-global-toast]').waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
  await page.locator('[data-app-id="tally"]').waitFor({ state: 'visible', timeout: 10_000 });
}

async function openTally() {
  const tile = page.locator('[data-app-id="tally"]');
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  await page.waitForTimeout(800);
  return frameLoc;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log('[tally] launched + Home ready');

  let frameLoc;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install', 'Install Tally from Discover', async () => {
      await installTally();
    });

    await step('open-welcome', 'Open Tally -> fresh-vault welcome dashboard', async () => {
      frameLoc = await openTally();
      await shot('01-welcome');
      const wrapText = await frameLoc.locator('#wrap').textContent();
      assert(/Welcome to Tally/.test(wrapText ?? ''), `expected the welcome empty state, got: ${JSON.stringify(wrapText?.slice(0, 200))}`);
    });

    await step('expense-blocked-without-group', 'Corner: Add expense without a group -> notice, no modal', async () => {
      await frameLoc.locator('#addExpenseBtn').click();
      await page.waitForTimeout(400);
      await shot('02-expense-blocked');
      const noticeText = await frameLoc.locator('#noticeBanner').textContent().catch(() => '');
      console.log(`[tally] notice: ${JSON.stringify(noticeText)}`);
      assert(/Create a group first/.test(noticeText ?? ''), 'expected "Create a group first" notice');
      assert((await frameLoc.locator('.kit-modal').count()) === 0, 'no expense modal should open without a group');
    });

    await step('add-friend', 'Add friend Bob', async () => {
      await frameLoc.locator('#addFriendBtn').click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await modal.locator('input.s-in').fill('Bob Marley');
      await modal.locator('button', { hasText: 'Add friend' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('03-friend-added');
      const sideText = await frameLoc.locator('#friendsNav').textContent();
      assert(/Bob/.test(sideText ?? ''), 'Bob not listed under FRIENDS in the sidebar');
    });

    await step('create-group', 'Create group "Road Trip" with Bob', async () => {
      await frameLoc.locator('#newGroupBtn').click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await modal.locator('input.s-in').fill('Road Trip');
      await modal.locator('.s-memtoggle button', { hasText: 'Bob' }).click();
      await modal.locator('button', { hasText: 'Create group' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(700);
      await shot('04-group-created');
      // create-group navigates into the group ledger view.
      const title = await frameLoc.locator('#activeTitle').textContent();
      assert(/Road Trip/.test(title ?? ''), `expected to land in the Road Trip group view, title: ${title}`);
    });

    await step('zero-amount-disabled', 'Corner: zero amount keeps Save disabled', async () => {
      await frameLoc.locator('#addExpenseBtn').click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await modal.locator('input.s-in').first().fill('Zero test');
      await modal.locator('input.s-amt').fill('0');
      await page.waitForTimeout(200);
      const saveBtn = modal.locator('button', { hasText: 'Save' });
      assert(await saveBtn.isDisabled(), 'Save should be disabled with a zero amount');
      await modal.locator('input.s-amt').fill('-5');
      await page.waitForTimeout(200);
      assert(await saveBtn.isDisabled(), 'Save should be disabled with a negative amount');
      await shot('05-zero-negative-disabled');
      await modal.locator('button', { hasText: 'Cancel' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 5000 });
    });

    await step('add-expense-60-equal', 'Add $60 expense you paid, equal split -> Bob owes you $30.00', async () => {
      await frameLoc.locator('#addExpenseBtn').click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await modal.locator('input.s-in').first().fill('Gas');
      await modal.locator('input.s-amt').fill('60');
      await page.waitForTimeout(300);
      const sumText = await modal.locator('.s-splitsum').textContent();
      console.log(`[tally] split sum line: ${JSON.stringify(sumText)}`);
      assert(/30\.00 each · 2 people/.test(norm(sumText)), `equal-split preview wrong: ${sumText}`);
      await modal.locator('button', { hasText: 'Save' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(800);
      await shot('06-expense-60-added');

      // Group balance chips: You get back $30.00, Bob owes $30.00.
      const balText = await frameLoc.locator('.s-balpanel').textContent().catch(() => '');
      console.log(`[tally] group balance chips: ${JSON.stringify(balText)}`);
      assert(/You get back [^\d]*30\.00/.test(norm(balText)), `group chip should say "You get back 30.00": ${balText}`);
      assert(/Bob owes [^\d]*30\.00/.test(norm(balText)), `group chip should say "Bob owes 30.00": ${balText}`);

      // Ledger row: "you lent" $30.00, sub "you paid $60.00".
      const rowText = await frameLoc.locator('.s-exrow', { hasText: 'Gas' }).textContent();
      assert(/you lent/.test(rowText ?? '') && /30\.00/.test(norm(rowText)), `ledger row wrong: ${rowText}`);
      assert(/you paid [^\d]*60\.00/.test(norm(rowText)), `ledger sub wrong: ${rowText}`);
    });

    await step('dashboard-after-e1', 'Dashboard totals: owed $30.00, owe $0.00, net +$30.00', async () => {
      await frameLoc.locator('.s-nav-item, button', { hasText: 'Dashboard' }).first().click();
      await page.waitForTimeout(600);
      await shot('07-dashboard-after-e1');
      const wrapText = await frameLoc.locator('#wrap').textContent();
      assert(/\+[^\d]*30\.00/.test(norm(wrapText)), `total balance should be +30.00: ${JSON.stringify(wrapText?.slice(0, 300))}`);
      assert(/Bob/.test(wrapText ?? '') && /owes you/.test(wrapText ?? ''), 'You-are-owed list should show Bob');
    });

    await step('odd-cent-split', 'Corner: $10.01 equal split -> shares $5.01 + $5.00 (no lost cent)', async () => {
      await frameLoc.locator('#addExpenseBtn').click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await modal.locator('input.s-in').first().fill('Odd cent snack');
      await modal.locator('input.s-amt').fill('10.01');
      // Paid by Bob this time.
      await modal.locator('.s-field', { hasText: 'Paid by' }).locator('select').selectOption({ label: 'Bob Marley' });
      await page.waitForTimeout(300);
      const sumText = await modal.locator('.s-splitsum').textContent();
      console.log(`[tally] odd-cent split sum: ${JSON.stringify(sumText)}`);
      await modal.locator('button', { hasText: 'Save' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(800);
      await shot('08-odd-cent-added');

      // Your share is round(1001/2)=501 (first member) -> you borrowed $5.01.
      // Net = 3000 - 501 = 2499 -> +$24.99.
      const wrapText = await frameLoc.locator('#wrap').textContent();
      assert(/\+[^\d]*24\.99/.test(norm(wrapText)), `net should be +24.99 after odd-cent expense: ${JSON.stringify(wrapText?.slice(0, 300))}`);
    });

    await step('expense-detail-modal', 'Open the odd-cent expense detail: split rows $5.01 (You) + $5.00 (Bob)', async () => {
      // Dashboard shows no ledger rows; go into the group.
      await frameLoc.locator('.s-gcard', { hasText: 'Road Trip' }).click();
      await page.waitForTimeout(600);
      await frameLoc.locator('.s-exrow', { hasText: 'Odd cent snack' }).click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await shot('09-detail-modal');
      const detailText = await modal.textContent();
      console.log(`[tally] detail modal text: ${JSON.stringify(detailText?.slice(0, 400))}`);
      assert(/10\.01/.test(norm(detailText)), 'detail modal missing the 10.01 total');
      assert(/5\.01/.test(norm(detailText)) && /5\.00/.test(norm(detailText)), 'detail modal split rows should show 5.01 and 5.00');
      assert(/Bob paid/.test(detailText ?? ''), 'detail modal should say Bob paid');
      await modal.locator('button', { hasText: 'Close' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 5000 });
    });

    await step('edit-expense', 'Edit the $60 expense to $80 (exact split 40/40) -> net +$34.99', async () => {
      await frameLoc.locator('.s-exrow', { hasText: 'Gas' }).click();
      const detail = frameLoc.locator('.kit-modal');
      await detail.waitFor({ state: 'visible', timeout: 5000 });
      await detail.locator('button', { hasText: 'Edit' }).click();
      await page.waitForTimeout(400);
      const editModal = frameLoc.locator('.kit-modal');
      await editModal.locator('input.s-amt').fill('80');
      // Edit mode lands on exact split showing the old 30/30 — rewrite to 40/40.
      const splitInputs = editModal.locator('input.s-splitin');
      const n = await splitInputs.count();
      assert(n === 2, `expected 2 exact-split inputs in edit mode, got ${n}`);
      await splitInputs.nth(0).fill('40');
      await splitInputs.nth(1).fill('40');
      await page.waitForTimeout(300);
      const sumText = await editModal.locator('.s-splitsum').textContent();
      console.log(`[tally] edit split sum: ${JSON.stringify(sumText)}`);
      assert(/✓/.test(sumText ?? ''), `exact split should validate: ${sumText}`);
      await editModal.locator('button', { hasText: 'Save' }).click();
      await editModal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(800);
      await shot('10-after-edit');
      // Net: Bob owes 40 (E1) minus you owe 5.01 (E2) = +$34.99.
      const balText = await frameLoc.locator('.s-balpanel').textContent().catch(() => '');
      console.log(`[tally] group chips after edit: ${JSON.stringify(balText)}`);
      assert(/You get back [^\d]*34\.99/.test(norm(balText)), `group chip should say "You get back 34.99": ${balText}`);
    });

    await step('delete-expense', 'Delete the odd-cent expense -> net back to +$40.00', async () => {
      await frameLoc.locator('.s-exrow', { hasText: 'Odd cent snack' }).click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      const delBtn = modal.locator('button', { hasText: 'Delete' });
      await delBtn.click();
      await page.waitForTimeout(150);
      await delBtn.click(); // arm-confirm
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(800);
      await shot('11-after-delete');
      const balText = await frameLoc.locator('.s-balpanel').textContent().catch(() => '');
      assert(/You get back [^\d]*40\.00/.test(norm(balText)), `group chip should say "You get back 40.00" after delete: ${balText}`);
      assert((await frameLoc.locator('.s-exrow', { hasText: 'Odd cent snack' }).count()) === 0, 'deleted expense still in the ledger');
    });

    await step('settle-up', 'Settle up: Bob pays you $40.00 -> group settled', async () => {
      await frameLoc.locator('#settleBtn').click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await modal.locator('input.s-amt').fill('40');
      await page.waitForTimeout(200);
      const hint = await modal.locator('.s-sub').textContent();
      console.log(`[tally] settle hint: ${JSON.stringify(hint)}`);
      assert(/Bob pays you [^\d]*40\.00/.test(norm(hint)), `settle hint wrong: ${hint}`);
      await modal.locator('button', { hasText: 'Record payment' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(800);
      await shot('12-after-settle');
      const balText = await frameLoc.locator('.s-balpanel').textContent().catch(() => '');
      console.log(`[tally] group chips after settle: ${JSON.stringify(balText)}`);
      assert(/You — settled/.test(balText ?? '') && /Bob — settled/.test(balText ?? ''), `both chips should be settled: ${balText}`);
    });

    await step('large-amount', 'Corner: $999999.99 expense renders with correct shares', async () => {
      await frameLoc.locator('#addExpenseBtn').click();
      const modal = frameLoc.locator('.kit-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await modal.locator('input.s-in').first().fill('Yacht');
      await modal.locator('input.s-amt').fill('999999.99');
      await page.waitForTimeout(300);
      const sumText = await modal.locator('.s-splitsum').textContent();
      console.log(`[tally] large-amount split sum: ${JSON.stringify(sumText)}`);
      // per = round(99999999/2) = 50000000 -> $500,000.00 each.
      assert(/500000\.00 each/.test(norm(sumText)), `large equal split preview wrong: ${sumText}`);
      await modal.locator('button', { hasText: 'Save' }).click();
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(800);
      await shot('13-large-amount');
      const balText = await frameLoc.locator('.s-balpanel').textContent().catch(() => '');
      // Bob's share = 99999999 - 50000000 = 49999999 -> $499,999.99.
      assert(/Bob owes [^\d]*499999\.99/.test(norm(balText)), `large-amount balance wrong: ${balText}`);
      // Clean up: delete it so activity/search checks stay simple.
      await frameLoc.locator('.s-exrow', { hasText: 'Yacht' }).click();
      const dm = frameLoc.locator('.kit-modal');
      await dm.waitFor({ state: 'visible', timeout: 5000 });
      const delBtn = dm.locator('button', { hasText: 'Delete' });
      await delBtn.click();
      await page.waitForTimeout(150);
      await delBtn.click();
      await dm.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(600);
    });

    await step('activity-view', 'Activity view lists the expense, edit trail and settlement', async () => {
      await frameLoc.locator('button', { hasText: 'Activity' }).first().click();
      await page.waitForTimeout(600);
      await shot('14-activity');
      const wrapText = await frameLoc.locator('#wrap').textContent();
      console.log(`[tally] activity text: ${JSON.stringify(wrapText?.slice(0, 400))}`);
      assert(/Gas/.test(wrapText ?? ''), 'activity missing the Gas expense');
      assert(/Bob paid you [^\d]*40\.00/.test(norm(wrapText)), 'activity missing the settlement');
    });

    await step('search', 'Search finds "Gas" with the group suffix', async () => {
      await frameLoc.locator('#searchInput').fill('Gas');
      await page.waitForTimeout(800);
      await shot('15-search');
      const wrapText = await frameLoc.locator('#wrap').textContent();
      assert(/Gas/.test(wrapText ?? '') && /Road Trip/.test(wrapText ?? ''), `search results should show Gas · Road Trip: ${JSON.stringify(wrapText?.slice(0, 300))}`);
      await frameLoc.locator('#searchInput').fill('');
      await page.waitForTimeout(400);
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ TALLY APPS-V2 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('===============================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: [${e.step}] ${e.text}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll Tally apps-v2 steps PASSED.');
    }
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'tally-FAILURE-fatal.png') });
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main();
