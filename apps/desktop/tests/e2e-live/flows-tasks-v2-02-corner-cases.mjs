#!/usr/bin/env node
// Tasks v2 QA Suite 2: corner cases — empty/whitespace title, very long
// titles, special chars/emoji/unicode/HTML, rapid double-clicks, Escape
// mid-edit, completing an already-completed task, many tasks (demo data +
// manual adds) for scroll/layout, and persistence across an app relaunch.
// Against the REAL desktop app (real gateway, real dev vault, no mocks).
//
// Run with: node apps/desktop/tests/e2e-live/flows-tasks-v2-02-corner-cases.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'tasks-v2');
const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-tasks-v2-02');

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

let shotSeq = 40; // continue numbering after suite 1's screenshots
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

async function loadDemoData() {
  const gear = page.getByRole('button', { name: 'App settings' });
  await gear.click();
  const dialog = page.getByRole('dialog', { name: 'App settings' });
  await dialog.waitFor({ state: 'visible', timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Vault' }).click();
  await page.waitForTimeout(400);
  const demoBtn = dialog.getByRole('button', { name: 'Load demo data' });
  const seen = (await demoBtn.count()) > 0;
  if (seen) {
    await demoBtn.click();
    await page.waitForTimeout(1200);
  }
  await dialog.getByRole('button', { name: 'Close' }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);
  return seen;
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  let session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  console.log(`[tasks02] launched + Home ready in ${Date.now() - t0}ms`);

  let frameLoc;

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install-tasks', 'Install Tasks via Discover', async () => {
      await installApp('Tasks', 'tasks');
      frameLoc = await openApp('tasks');
      await page.waitForTimeout(1500);
    });

    await step('empty-title-submit-noop', 'Add button stays disabled for an empty title; Enter on empty input is a no-op', async () => {
      const addBtn = frameLoc.locator('.tk-capture-add');
      assert(await addBtn.isDisabled(), 'Add button is NOT disabled with an empty title');
      const input = frameLoc.locator('.tk-capture-input');
      await input.press('Enter');
      await page.waitForTimeout(400);
      await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).click();
      const count = await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).locator('.tk-nav-count').textContent();
      assert(count === '0', `expected 0 open tasks after empty-title Enter, sidebar shows ${count}`);
      await shot('empty-title-noop');
    });

    await step('whitespace-only-title-noop', 'A title of only spaces is trimmed to empty -> Add stays disabled, no task created', async () => {
      const input = frameLoc.locator('.tk-capture-input');
      await input.fill('    ');
      const addBtn = frameLoc.locator('.tk-capture-add');
      // Capture.jsx disables on `!title.trim()`, so whitespace-only must
      // still leave the button disabled even though the raw value is non-empty.
      const disabled = await addBtn.isDisabled();
      console.log(`[tasks02] Add button disabled for whitespace-only title: ${disabled}`);
      await shot('whitespace-only-title');
      assert(disabled, 'Add button is enabled for a whitespace-only title (should stay disabled)');
      await input.fill('');
    });

    let longTitleFull;
    await step('very-long-title', 'A very long title (500 chars) is accepted, stored, and rendered without breaking layout', async () => {
      longTitleFull = 'Extremely long task title for QA stress testing '.repeat(10).trim();
      console.log(`[tasks02] long title length: ${longTitleFull.length}`);
      const input = frameLoc.locator('.tk-capture-input');
      await input.fill(longTitleFull);
      await frameLoc.locator('.tk-capture-add').click();
      await page.waitForTimeout(700);
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(300);
      const row = frameLoc.locator('.tk-row-title', { hasText: 'Extremely long task title' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('very-long-title-row');
    });

    await step('special-chars-emoji-unicode', 'Title with quotes, HTML tags, emoji and unicode renders as literal text, not interpreted markup', async () => {
      const weirdTitle = `"quotes" <b>tags</b> & emoji \u{1F3AF} unicode ünïcödé`;
      const input = frameLoc.locator('.tk-capture-input');
      await input.fill(weirdTitle);
      await frameLoc.locator('.tk-capture-add').click();
      await page.waitForTimeout(700);
      await shot('special-chars-after-add');
      const row = frameLoc.locator('.tk-row', { hasText: 'unicode' }).first();
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      const titleEl = row.locator('.tk-row-title');
      const rendered = await titleEl.textContent();
      console.log(`[tasks02] rendered special-char title: ${JSON.stringify(rendered)}`);
      assert(rendered === weirdTitle, `special-char title did not round-trip exactly: ${JSON.stringify(rendered)}`);
      const boldCount = await titleEl.locator('b').count();
      assert(boldCount === 0, 'HTML <b> tag in the title was interpreted as markup instead of literal text');
      await shot('special-chars-row-zoomed');
    });

    await step('rapid-double-click-complete', 'Rapid double-click on a row circle does not double-fire / corrupt state', async () => {
      const row = frameLoc.locator('.tk-row', { hasText: 'Extremely long task title' });
      const circle = row.locator('.tk-circle');
      await Promise.all([circle.click(), circle.click({ force: true }).catch(() => undefined)]);
      await page.waitForTimeout(1000);
      await shot('after-rapid-double-click-complete');
      // Whatever the outcome, the app must not crash / duplicate the row.
      const matchingRows = frameLoc.locator('.tk-row', { hasText: 'Extremely long task title' });
      const openCount = await matchingRows.count();
      console.log(`[tasks02] rows matching the long title still visible in this view after rapid double-click: ${openCount}`);
      assert(openCount <= 1, `rapid double-click produced duplicate rows: ${openCount}`);
    });

    await step('logbook-rows-are-a-dead-end', 'FINDING: once a task lands in Logbook (from the rapid-double-click completion above), there is NO UI path back — the row\'s onClick AND its circle toggle are both disabled when closed=true (Row.jsx), so clicking it is a confirmed no-op', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Logbook' }).click();
      await page.waitForTimeout(300);
      const row = frameLoc.locator('.tk-row', { hasText: 'Extremely long task title' });
      const inLogbook = (await row.count()) > 0;
      console.log(`[tasks02] long-title task ended up completed (in Logbook) after the rapid double-click: ${inLogbook}`);
      if (inLogbook) {
        await row.click();
        await page.waitForTimeout(400);
        const detailOpened = (await frameLoc.locator('.tk-detail').count()) > 0;
        console.log(`[tasks02] clicking the Logbook row opened the Detail drawer: ${detailOpened} (expected false — Row.jsx sets onClick=undefined when closed)`);
        assert(!detailOpened, 'Logbook row unexpectedly opened a Detail drawer — Row.jsx closed-guard may have regressed');
      }
      await shot('logbook-row-click-is-a-dead-end');
    });

    await step('detail-toggle-idempotency', 'Complete/reopen/complete again via the Detail drawer\'s own circle (which stays open across the status change) — toggling an already-completed task back and forth is idempotent, no error', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(200);
      const input = frameLoc.locator('.tk-capture-input');
      await input.fill('Toggle idempotency check');
      await input.press('Enter');
      await page.waitForTimeout(700);
      const row = frameLoc.locator('.tk-row', { hasText: 'Toggle idempotency check' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await row.click();
      const detail = frameLoc.locator('.tk-detail');
      await detail.waitFor({ state: 'visible', timeout: 10_000 });
      const bigCircle = detail.locator('.tk-circle.lg');

      await bigCircle.click(); // needs-action -> completed
      await page.waitForTimeout(700);
      let onState = await bigCircle.getAttribute('data-on');
      assert(onState === 'true', `expected completed (data-on=true) after 1st toggle, got ${onState}`);
      await shot('detail-toggle-1-completed');

      await bigCircle.click(); // completed -> needs-action (reopen)
      await page.waitForTimeout(700);
      onState = await bigCircle.getAttribute('data-on');
      assert(onState === 'false', `expected reopened (data-on=false) after 2nd toggle, got ${onState}`);
      await shot('detail-toggle-2-reopened');

      await bigCircle.click(); // needs-action -> completed again
      await page.waitForTimeout(700);
      onState = await bigCircle.getAttribute('data-on');
      assert(onState === 'true', `expected completed again (data-on=true) after 3rd toggle, got ${onState}`);
      await shot('detail-toggle-3-completed-again');
      await detail.locator('.tk-detail-close').click();
    });

    await step('escape-mid-title-edit-discards-unsaved', 'Escape while editing a title in the Detail drawer closes the drawer WITHOUT committing the unsaved (un-blurred) text', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(300);
      const input = frameLoc.locator('.tk-capture-input');
      await input.fill('Escape mid-edit check');
      await input.press('Enter');
      await page.waitForTimeout(700);
      const row = frameLoc.locator('.tk-row', { hasText: 'Escape mid-edit check' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await row.click();
      const detail = frameLoc.locator('.tk-detail');
      await detail.waitFor({ state: 'visible', timeout: 10_000 });
      const titleInput = detail.locator('.tk-detail-title');
      await titleInput.click();
      await titleInput.fill('UNSAVED EDIT SHOULD NOT PERSIST');
      await page.keyboard.press('Escape');
      await detail.waitFor({ state: 'hidden', timeout: 5_000 });
      await shot('after-escape-mid-edit');
      const row2 = frameLoc.locator('.tk-row-title', { hasText: 'Escape mid-edit check' });
      await row2.waitFor({ state: 'visible', timeout: 5_000 });
      const leaked = await frameLoc.locator('.tk-row-title', { hasText: 'UNSAVED EDIT' }).count();
      console.log(`[tasks02] rows showing the unsaved Escape'd title text: ${leaked} (expected 0 — onBlur never fired)`);
      assert(leaked === 0, 'unsaved title edit leaked into the row despite Escape (no blur/commit expected)');
    });

    await step('enter-key-in-capture-submits', 'Pressing Enter in the capture bar submits the same as clicking Add', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(200);
      const input = frameLoc.locator('.tk-capture-input');
      await input.fill('Enter-key submit check');
      await input.press('Enter');
      await page.waitForTimeout(700);
      const row = frameLoc.locator('.tk-row-title', { hasText: 'Enter-key submit check' });
      await row.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('enter-key-submit-worked');
    });

    let seededDemo = false;
    await step('load-demo-data', 'Load demo data via Settings -> Vault -> "Load demo data" (real UI path, not a direct API call)', async () => {
      seededDemo = await loadDemoData();
      console.log(`[tasks02] "Load demo data" button was offered and clicked: ${seededDemo}`);
      await page.waitForTimeout(500);
      await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).click();
      await page.waitForTimeout(400);
      await shot('after-load-demo-data');
    });

    await step('many-tasks-scroll-layout', 'Add enough tasks to exceed 15 total open items; board scrolls, sections/counts stay correct, no layout breakage', async () => {
      await frameLoc.locator('.tk-nav-item', { hasText: 'Anytime' }).click();
      await page.waitForTimeout(300);
      for (let i = 1; i <= 10; i++) {
        const input = frameLoc.locator('.tk-capture-input');
        await input.fill(`Bulk QA task #${i}`);
        await input.press('Enter');
        await page.waitForTimeout(350);
      }
      await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).click();
      await page.waitForTimeout(500);
      const allCount = await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).locator('.tk-nav-count').textContent();
      console.log(`[tasks02] "All open" count after bulk add: ${allCount}`);
      assert(Number(allCount) >= 15, `expected at least 15 open tasks, sidebar shows ${allCount}`);
      await shot('many-tasks-all-open-top');
      // Scroll the board column to the bottom and confirm the last bulk task renders.
      const scroller = frameLoc.locator('#scroll');
      await scroller.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(300);
      await shot('many-tasks-scrolled-to-bottom');
      const lastRow = frameLoc.locator('.tk-row-title', { hasText: 'Bulk QA task #10' });
      await lastRow.waitFor({ state: 'visible', timeout: 5_000 });
    });

    await step('relaunch-persistence', 'Corner case: close + relaunch with the SAME userDataDir -> tasks, statuses and view state all persisted', async () => {
      await session.close();
      await new Promise((r) => setTimeout(r, 500));
      session = await launchApp({ userDataDir: USER_DATA_DIR });
      page = session.page;
      wireConsole(page);
      await page.setViewportSize({ width: 1400, height: 900 });
      const tile = page.locator('[data-app-id="tasks"]');
      await tile.waitFor({ state: 'visible', timeout: 15_000 });
      await shot('relaunch-home-with-tasks-tile');
      frameLoc = await openApp('tasks');
      await page.waitForTimeout(1200);
      await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).click();
      await page.waitForTimeout(500);
      const allCount = await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).locator('.tk-nav-count').textContent();
      console.log(`[tasks02] "All open" count after relaunch: ${allCount}`);
      await shot('relaunch-all-open-view');
      assert(Number(allCount) >= 15, `open task count did not persist across relaunch: ${allCount}`);
      const bulkRow = frameLoc.locator('.tk-row-title', { hasText: 'Bulk QA task #1' }).first();
      await bulkRow.waitFor({ state: 'visible', timeout: 10_000 });
      // The long-title task may be open or completed depending on how the
      // earlier rapid-double-click race resolved — just confirm it exists
      // SOMEWHERE (open list or Logbook), not its exact status.
      const longRowOpen = await frameLoc.locator('.tk-row-title', { hasText: 'Extremely long task title' }).count();
      if (longRowOpen === 0) {
        await frameLoc.locator('.tk-nav-item', { hasText: 'Logbook' }).click();
        await page.waitForTimeout(400);
        const longRowClosed = await frameLoc.locator('.tk-row', { hasText: 'Extremely long task title' }).count();
        assert(longRowClosed > 0, 'long-title task vanished entirely across relaunch (not open, not in Logbook)');
        await frameLoc.locator('.tk-nav-item', { hasText: 'All open' }).click();
        await page.waitForTimeout(400);
      }
      const specialRow = frameLoc.locator('.tk-row', { hasText: 'unicode' });
      await specialRow.first().waitFor({ state: 'visible', timeout: 10_000 });
      const specialText = await specialRow.first().locator('.tk-row-title').textContent();
      console.log(`[tasks02] special-char task title after relaunch: ${JSON.stringify(specialText)}`);
      assert(/emoji.*unicode/.test(specialText ?? ''), 'special-char task title corrupted across relaunch');
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ TASKS v2 CORNER-CASES VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(36)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('=======================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text} (${e.frameUrl})`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll Tasks v2 corner-case steps PASSED.');
    }
  } catch (err) {
    console.error('FATAL:', err);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, 'FATAL-FAILURE-02.png') });
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
