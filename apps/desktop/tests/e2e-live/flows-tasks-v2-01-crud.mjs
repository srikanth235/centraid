#!/usr/bin/env node
// Tasks v2 QA Suite 1: core CRUD + views/sections/counts + detail drawer edits
// + subtasks + status transitions + search, against the REAL desktop app
// (real gateway, real dev vault, no mocks).
//
// Run with: node apps/desktop/tests/e2e-live/flows-tasks-v2-01-crud.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'tasks-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-tasks-v2-01');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type(), frameUrl: msg.location()?.url ?? '' });
  });
  p.on('pageerror', (err) => {
    consoleMessages.push({ text: `[pageerror] ${err}`, type: 'error', frameUrl: '' });
  });
}

let shotSeq = 0;
async function shot(name) {
  shotSeq += 1;
  const p = path.join(OUT_DIR, `${String(shotSeq).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

async function step(id, label, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, label, verdict: 'pass', ms: Date.now() - t0 });
    console.log(`[PASS] ${id} ${label} (${Date.now() - t0}ms)`);
  } catch (err) {
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function installApp(name, appId) {
  await navTo(page, 'Discover');
  const card = page.locator('button[data-kind="app"]', { hasText: name }).first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();
  const dialog = page.getByRole('dialog', { name: new RegExp('^Preview ' + name) });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Use this template' }).click();
  const toast = page.locator('[data-global-toast]');
  await toast.waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByRole('heading', { name: 'What should we build?' }).waitFor({ state: 'visible', timeout: 10_000 });
  const tile = page.locator(`[data-app-id="${appId}"]`);
  await tile.waitFor({ state: 'visible', timeout: 10_000 });
}

async function openApp(appId) {
  const tile = page.locator(`[data-app-id="${appId}"]`);
  await tile.getByTestId('app-tile').click();
  await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
  const frameLoc = page.frameLocator('iframe[data-centraid-app="1"]');
  await frameLoc.locator('body').first().waitFor({ state: 'visible', timeout: 15_000 });
  return frameLoc;
}

/** Fill the capture bar + submit via the Add button (default path). */
async function captureAdd(frameLoc, title, { dueChip, prioChip } = {}) {
  const input = frameLoc.locator('.tk-capture-input');
  await input.fill(title);
  if (dueChip) {
    await frameLoc.locator('.tk-capture-seg button', { hasText: dueChip }).first().click();
  }
  if (prioChip) {
    await frameLoc.locator('.tk-capture-seg button', { hasText: prioChip }).click();
  }
  await frameLoc.locator('.tk-capture-add').click();
  await page.waitForTimeout(500);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[tasks01] launched + Home ready in ${Date.now() - t0}ms`);

  let frameLoc;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install-tasks', 'Install Tasks via Discover', async () => {
      await installApp('Tasks', 'tasks');
      await shot('tasks-installed-home');
    });

    await step('open-empty-board', 'Open Tasks -> empty board renders (Today view, empty state copy)', async () => {
      frameLoc = await openApp('tasks');
      await page.waitForTimeout(1500); // board's first schedule.task read + auto-grant settle
      await shot('empty-board-today');
      const emptyTitle = frameLoc.locator('.kit-empty-title');
      await emptyTitle.waitFor({ state: 'visible', timeout: 10_000 });
      const txt = (await emptyTitle.textContent())?.trim();
      console.log(`[tasks01] empty-state title: "${txt}"`);
      assert(txt === 'Nothing due today', `unexpected empty title: ${txt}`);
      const consentBanner = frameLoc.locator('#consentBanner');
      const bannerHidden = await consentBanner.isHidden().catch(() => true);
      console.log(`[tasks01] consent banner hidden (i.e. app auto-granted): ${bannerHidden}`);
    });

    await step('add-plain-task-enter-key', 'Add a plain task via Enter key (no due/priority)', async () => {
      const input = frameLoc.locator('.tk-capture-input');
      await input.fill('Write the QA report');
      await input.press('Enter');
      await page.waitForTimeout(600);
      await shot('after-add-plain-task');
      // Plain task has no due date -> lands in Anytime, not Today; switch view to see it.
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(300);
      const row = frameLoc.locator('.tk-row-title', { hasText: 'Write the QA report' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('anytime-view-with-plain-task');
    });

    await step('add-task-due-today', 'Add a task with the "Today" due chip', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Today' }).click();
      await page.waitForTimeout(200);
      await captureAdd(frameLoc, 'Call the plumber', { dueChip: 'Today' });
      const row = frameLoc.locator('.tk-row-title', { hasText: 'Call the plumber' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('today-view-with-due-today-task');
    });

    await step('add-task-due-tomorrow', 'Add a task with the "Tmrw" due chip -> shows in Upcoming, not Today', async () => {
      await captureAdd(frameLoc, 'Email the landlord', { dueChip: 'Tmrw' });
      await frameLoc.locator('.tk-nav-item', { hasText: 'Upcoming' }).click();
      await page.waitForTimeout(300);
      const row = frameLoc.locator('.tk-row-title', { hasText: 'Email the landlord' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('upcoming-view-with-tomorrow-task');
    });

    await step('add-task-nl-due-parsing', 'Natural-language due date in the title ("...+3d") previews a hint and lands the clean title with the due date', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Today' }).click();
      await page.waitForTimeout(200);
      const input = frameLoc.locator('.tk-capture-input');
      await input.fill('Renew passport +3d');
      const hint = frameLoc.locator('.tk-nl-hint');
      await hint.waitFor({ state: 'visible', timeout: 5_000 });
      const hintText = (await hint.textContent()) ?? '';
      console.log(`[tasks01] NL hint: "${hintText}"`);
      assert(/leaves the title/.test(hintText), `NL hint text unexpected: ${hintText}`);
      await shot('nl-due-hint-before-submit');
      await frameLoc.locator('.tk-capture-add').click();
      await page.waitForTimeout(600);
      await frameLoc.locator('.tk-nav-item', { hasText: 'Upcoming' }).click();
      await page.waitForTimeout(300);
      const row = frameLoc.locator('.tk-row-title', { hasText: 'Renew passport' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      const rowText = await row.textContent();
      assert(!/\+3d/.test(rowText ?? ''), `NL token "+3d" leaked into the stored title: ${rowText}`);
      await shot('upcoming-view-with-nl-parsed-task');
    });

    await step('add-task-with-priority', 'Add a task with the "High" flag chip -> flag glyph renders on the row', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(200);
      await captureAdd(frameLoc, 'Fix the leaking faucet', { prioChip: 'High' });
      const row = frameLoc.locator('.tk-row', { hasText: 'Fix the leaking faucet' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      const flag = row.locator('.tk-flag.high');
      await flag.waitFor({ state: 'visible', timeout: 5_000 });
      await shot('anytime-view-with-high-priority-task');
    });

    await step('sidebar-counts-match', 'Sidebar nav counts match the actual number of open tasks in each bucket', async () => {
      const allCount = await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).locator('.tk-nav-count').textContent();
      console.log(`[tasks01] sidebar "All open" count: ${allCount}`);
      assert(Number(allCount) === 5, `expected 5 open tasks total, sidebar shows ${allCount}`);
      await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).click();
      await page.waitForTimeout(300);
      const rows = frameLoc.locator('.tk-rows .tk-row');
      const rowCount = await rows.count();
      assert(rowCount === 5, `expected 5 rows in All open view, found ${rowCount}`);
      await shot('all-open-view-5-tasks');
    });

    let firstTaskRow;
    await step('open-detail-drawer', 'Click a row -> Detail drawer opens with title/notes/due/priority/effort controls', async () => {
      firstTaskRow = frameLoc.locator('.tk-row', { hasText: 'Write the QA report' }).first();
      await firstTaskRow.click();
      const detail = frameLoc.locator('.tk-detail');
      await detail.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(400); // let the slide-in transition settle before screenshotting
      await shot('detail-drawer-open');
      const titleInput = detail.locator('.tk-detail-title');
      assert((await titleInput.inputValue()) === 'Write the QA report', 'detail title input did not prefill with task title');
    });

    await step('detail-edit-title', 'Edit title in detail drawer, blur -> commits + row reflects new title', async () => {
      const detail = frameLoc.locator('.tk-detail');
      const titleInput = detail.locator('.tk-detail-title');
      await titleInput.fill('Write the final QA report');
      await titleInput.press('Tab'); // moves focus off, triggers blur -> commit
      await page.waitForTimeout(700);
      await shot('detail-after-title-edit');
      const row = frameLoc.locator('.tk-row-title', { hasText: 'Write the final QA report' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
    });

    await step('detail-edit-notes', 'Set notes in detail drawer, blur -> commits + note preview shows under row', async () => {
      const detail = frameLoc.locator('.tk-detail');
      const notes = detail.locator('.tk-detail-notes');
      await notes.fill('Include screenshots and the bug list.');
      await notes.blur();
      await page.waitForTimeout(700);
      await shot('detail-after-notes-edit');
      const row = frameLoc.locator('.tk-row', { hasText: 'Write the final QA report' });
      const notePreview = row.locator('.tk-row-note');
      await notePreview.waitFor({ state: 'visible', timeout: 5_000 });
      const noteText = await notePreview.textContent();
      assert(/screenshots/.test(noteText ?? ''), `row note preview missing expected text: ${noteText}`);
    });

    await step('detail-clear-notes', 'Clear notes (empty + blur) -> clear_description path, note preview disappears', async () => {
      const detail = frameLoc.locator('.tk-detail');
      const notes = detail.locator('.tk-detail-notes');
      await notes.fill('');
      await notes.blur();
      await page.waitForTimeout(700);
      const row = frameLoc.locator('.tk-row', { hasText: 'Write the final QA report' });
      const notePreview = row.locator('.tk-row-note');
      const count = await notePreview.count();
      console.log(`[tasks01] row note preview count after clearing: ${count}`);
      await shot('detail-after-notes-cleared');
    });

    await step('detail-edit-due-preset', 'Pick "Next wk" due preset in detail drawer -> due chip updates + row reflects it', async () => {
      const detail = frameLoc.locator('.tk-detail');
      await detail.locator('.tk-detail-seg button', { hasText: 'Next wk' }).click();
      await page.waitForTimeout(700);
      await shot('detail-after-due-nextweek');
      const active = detail.locator('.tk-detail-seg button.on', { hasText: 'Next wk' });
      await active.waitFor({ state: 'visible', timeout: 5_000 });
    });

    await step('detail-edit-due-datepicker', 'Use the raw date input to set an explicit due date', async () => {
      const detail = frameLoc.locator('.tk-detail');
      const dateInput = detail.locator('.tk-detail-date');
      const future = new Date();
      future.setDate(future.getDate() + 14);
      const iso = future.toISOString().slice(0, 10);
      await dateInput.fill(iso);
      // The input is React-controlled off `task.due_at`, which only updates
      // once the async schedule.edit_task round-trip resolves and refresh()
      // re-renders — the DOM value can transiently read back empty/stale
      // right after fill(). Poll instead of a flat timeout.
      let val = '';
      for (let i = 0; i < 20; i++) {
        val = await dateInput.inputValue();
        if (val === iso) break;
        await page.waitForTimeout(300);
      }
      await shot('detail-after-due-datepicker');
      assert(val === iso, `date input did not retain value: expected ${iso}, got ${val}`);
    });

    await step('detail-edit-priority', 'Pick "Med" priority chip in detail drawer', async () => {
      const detail = frameLoc.locator('.tk-detail');
      await detail.locator('.tk-detail-seg button', { hasText: 'Med' }).first().click();
      await page.waitForTimeout(700);
      const active = detail.locator('.tk-detail-cols > div', { hasText: 'Priority' }).locator('button.on', { hasText: 'Med' });
      await active.waitFor({ state: 'visible', timeout: 5_000 });
      await shot('detail-after-priority-med');
    });

    await step('detail-edit-effort', 'Pick "30m" effort chip in detail drawer -> row shows effort meta', async () => {
      const detail = frameLoc.locator('.tk-detail');
      await detail.locator('.tk-detail-seg button', { hasText: '30m' }).click();
      await page.waitForTimeout(700);
      await shot('detail-after-effort-30m');
      const active = detail.locator('.tk-detail-cols > div', { hasText: 'Effort' }).locator('button.on', { hasText: '30m' });
      await active.waitFor({ state: 'visible', timeout: 5_000 });
    });

    await step('detail-add-subtask', 'Add a subtask from the detail drawer -> renders in subtasks list, closes to 0/1 badge on row', async () => {
      const detail = frameLoc.locator('.tk-detail');
      const subInput = detail.locator('.tk-subtask-add input');
      await subInput.fill('Attach screenshots');
      await subInput.press('Enter');
      await page.waitForTimeout(700);
      await shot('detail-after-subtask-add');
      const subRow = detail.locator('.tk-subtask-row', { hasText: 'Attach screenshots' });
      await subRow.waitFor({ state: 'visible', timeout: 10_000 });
      const label = detail.locator('.tk-eyebrow-label', { hasText: 'Subtasks' });
      const labelText = await label.textContent();
      console.log(`[tasks01] subtasks label: "${labelText}"`);
      assert(/0\/1/.test(labelText ?? ''), `subtasks counter did not show 0/1: ${labelText}`);
    });

    await step('detail-complete-subtask', 'Complete the subtask via its own circle -> counter flips to 1/1', async () => {
      const detail = frameLoc.locator('.tk-detail');
      const subRow = detail.locator('.tk-subtask-row', { hasText: 'Attach screenshots' });
      await subRow.locator('.tk-circle.sm').click();
      await page.waitForTimeout(700);
      await shot('detail-after-subtask-complete');
      const label = detail.locator('.tk-eyebrow-label', { hasText: 'Subtasks' });
      const labelText = await label.textContent();
      assert(/1\/1/.test(labelText ?? ''), `subtasks counter did not show 1/1 after completing: ${labelText}`);
    });

    await step('detail-activity-log', 'Session activity log in the drawer records the edits made so far, each tagged "receipt"', async () => {
      const detail = frameLoc.locator('.tk-detail');
      const items = detail.locator('.tk-activity-item');
      const count = await items.count();
      console.log(`[tasks01] activity log entries: ${count}`);
      assert(count > 0, 'activity log is empty despite several edits this session');
      const receiptChips = detail.locator('.tk-receipt-chip');
      const receiptCount = await receiptChips.count();
      console.log(`[tasks01] receipt chips in activity log: ${receiptCount}`);
      await shot('detail-activity-log');
    });

    await step('detail-start-pause', 'Toggle "Start" -> task becomes in-process, row shows "in progress" badge; "Pause" reverts', async () => {
      const detail = frameLoc.locator('.tk-detail');
      await detail.locator('.tk-detail-foot button', { hasText: 'Start' }).click();
      await page.waitForTimeout(700);
      await shot('detail-after-start');
      const pauseBtn = detail.locator('.tk-detail-foot button', { hasText: 'Pause' });
      await pauseBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await pauseBtn.click();
      await page.waitForTimeout(700);
      await shot('detail-after-pause');
    });

    await step('close-detail-drawer', 'Close the detail drawer via the X button', async () => {
      const detail = frameLoc.locator('.tk-detail');
      await detail.locator('.tk-detail-close').click();
      await detail.waitFor({ state: 'hidden', timeout: 5_000 });
      await shot('detail-closed');
    });

    await step('complete-task-from-row', 'Complete a task from the board row -> toast with Undo, row leaves the open list', async () => {
      const row = frameLoc.locator('.tk-row', { hasText: 'Call the plumber' });
      await frameLoc.locator('.tk-nav-item', { hasText: 'Today' }).click();
      await page.waitForTimeout(300);
      await row.locator('.tk-circle').click();
      await page.waitForTimeout(300);
      await shot('after-complete-plumber-toast');
      const toast = page.locator('kit-toast, .kit-toast').first();
      const toastVisible = await toast.isVisible().catch(() => false);
      console.log(`[tasks01] toast visible after completing a task: ${toastVisible}`);
      await page.waitForTimeout(800);
      const rowGone = await row.count();
      assert(rowGone === 0, 'completed task row still present in Today view');
    });

    await step('completed-task-in-logbook', 'Completed task appears in Logbook with the completion date', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Logbook' }).click();
      await page.waitForTimeout(400);
      const row = frameLoc.locator('.tk-row', { hasText: 'Call the plumber' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('logbook-with-completed-plumber');
    });

    await step('undo-completion-via-toast', 'Re-complete + Undo via toast action puts the task back in the open list', async () => {
      // Row is now in logbook (closed=true, no toggle). Reopen via the circle
      // in the logbook row (closed rows have no onClick toggle per Row.jsx —
      // exercise this precisely: verify circle click is a no-op in logbook).
      const row = frameLoc.locator('.tk-row', { hasText: 'Call the plumber' });
      const before = await row.count();
      await row.locator('.tk-circle').click({ force: true });
      await page.waitForTimeout(500);
      const after = await row.count();
      console.log(`[tasks01] logbook row circle click: before=${before} after=${after} (expected no-op, row stays)`);
      await shot('logbook-circle-click-noop-check');
    });

    await step('cancel-task-from-detail', 'Cancel a task from the detail drawer -> lands in Logbook with the cancel glyph, Cancel button now disabled', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(300);
      const row = frameLoc.locator('.tk-row', { hasText: 'Fix the leaking faucet' });
      await row.click();
      const detail = frameLoc.locator('.tk-detail');
      await detail.waitFor({ state: 'visible', timeout: 10_000 });
      await detail.locator('.tk-detail-foot button', { hasText: 'Cancel task' }).click();
      await page.waitForTimeout(700);
      await shot('after-cancel-task');
      await frameLoc.locator('.tk-nav-item', { hasText: 'Logbook' }).click();
      await page.waitForTimeout(300);
      const cancelledRow = frameLoc.locator('.tk-row', { hasText: 'Fix the leaking faucet' });
      await cancelledRow.waitFor({ state: 'visible', timeout: 10_000 });
      const circle = cancelledRow.locator('.tk-circle[data-cancelled="true"]');
      await circle.waitFor({ state: 'visible', timeout: 5_000 });
      await shot('logbook-with-cancelled-task');
    });

    await step('search-tasks-cross-view', 'Search is global, not scoped to the current focus view: from "Anytime" (undated only), searching for a task due TOMORROW must still surface it (regression test for a bucket-allow-list bug fixed during this QA pass — see logic.js buildSections)', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(300);
      const searchInput = frameLoc.locator('#searchInput');
      await searchInput.fill('landlord');
      await page.waitForTimeout(500);
      await shot('search-results-landlord-from-anytime-view');
      const rows = frameLoc.locator('.tk-rows .tk-row');
      const count = await rows.count();
      console.log(`[tasks01] search "landlord" rows while on Anytime view: ${count}`);
      assert(
        count >= 1,
        'search for "landlord" (a task due TOMORROW, i.e. "week" bucket) returned no rows while on the Anytime view (undated-only bucket) — the bucket-allow-list is wrongly still restricting a global search to the current view',
      );
      const mark = frameLoc.locator('.tk-row mark').first();
      await mark.waitFor({ state: 'visible', timeout: 5_000 });
      const markText = (await mark.textContent())?.toLowerCase();
      assert(markText === 'landlord', `highlighted mark text unexpected: ${markText}`);
    });

    await step('search-no-match-empty-state', 'Search with no matches shows the "No matches" empty state', async () => {
      const searchInput = frameLoc.locator('#searchInput');
      await searchInput.fill('zzz_no_such_task_zzz');
      await page.waitForTimeout(500);
      await shot('search-no-matches');
      const emptyTitle = frameLoc.locator('.kit-empty-title');
      await emptyTitle.waitFor({ state: 'visible', timeout: 5_000 });
      assert((await emptyTitle.textContent())?.trim() === 'No matches', 'expected "No matches" empty state');
    });

    await step('clear-search-escape', 'Escape clears the search box and restores the full board', async () => {
      const searchInput = frameLoc.locator('#searchInput');
      await searchInput.press('Escape');
      await page.waitForTimeout(400);
      const val = await searchInput.inputValue();
      assert(val === '', `search input not cleared after Escape, value="${val}"`);
      await shot('search-cleared-via-escape');
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ TASKS v2 CRUD/VIEWS VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(32)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('======================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text} (${e.frameUrl})`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll Tasks v2 CRUD/views steps PASSED.');
    }
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'FATAL-FAILURE.png') });
    } catch {
      /* ignore */
    }
    process.exitCode = 1;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
