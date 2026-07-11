#!/usr/bin/env node
// Agenda v2 QA Suite 1: fresh dev vault (no seed.js — Agenda never seeds its
// own rows, see packages/blueprints/apps/agenda/logic.js header comment),
// install via Discover -> Use this template, and observe the truly EMPTY
// vault experience across all three views (month/week/schedule) plus the
// mini-month and "My calendars" sidebar with zero calendars. Leaves the
// installed app + userDataDir behind (reused by suites 2-4).
//
// Run with: node apps/desktop/tests/e2e-live/flows-agenda-v2-01-empty-install.mjs
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'agenda-v2');
export const USER_DATA_DIR = path.join(__dirname, 'out', 'userdata-agenda-v2');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

const results = [];
let page;
let session;
const consoleMessages = [];

function wireConsole(p) {
  p.on('console', (msg) => {
    consoleMessages.push({ text: msg.text(), type: msg.type(), frameUrl: msg.location()?.url ?? '' });
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
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-agv2-1-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `1-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[agv2-1] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('flow1-install', 'Discover -> preview Agenda -> Use this template installs + pins to Home', async () => {
      await navTo(page, 'Discover');
      const agendaCard = page.locator('button[data-kind="app"]', { hasText: 'Agenda' }).first();
      await agendaCard.waitFor({ state: 'visible', timeout: 20_000 });
      await agendaCard.click();
      const dialog = page.getByRole('dialog', { name: /^Preview Agenda/ });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await shot('01-discover-preview-agenda');
      await dialog.getByRole('button', { name: 'Use this template' }).click();
      const toast = page.locator('[data-global-toast]');
      await toast.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);
      const tile = page.locator('[data-app-id="agenda"]');
      await tile.waitFor({ state: 'visible', timeout: 20_000 });
      await shot('02-home-with-agenda-tile');
    });

    await step('flow2-open-empty-month', 'Open Agenda -> empty vault, default Month view renders with no consent banner blocking', async () => {
      const tile = page.locator('[data-app-id="agenda"]');
      await tile.getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
      // Note: the v2 React rewrite has no literal <h1> anywhere in the app
      // (grepped packages/blueprints/apps/agenda/**) -- "Agenda" only
      // appears in the static `.ag-brand-name` sidebar div and the
      // <title>. iframe-probe.mjs's `h1Text === 'Agenda'` assertion is
      // therefore stale against this app now; use a v2-real selector.
      const fl = frameLoc(page);
      await fl.locator('.ag-brand-name', { hasText: 'Agenda' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(1000); // let the first `upcoming` read resolve
      const consentVisible = await fl.locator('#consentBanner').isVisible().catch(() => false);
      console.log(`[agv2-1] consent banner visible on first open: ${consentVisible}`);
      await shot('03-empty-month-view');
      // Month grid should render 42 cells with zero pills, not an error state.
      const cellCount = await fl.locator('.ag-day-cell').count();
      assert(cellCount === 42, `expected 42 month-grid cells, got ${cellCount}`);
      const pillCount = await fl.locator('.ag-pill').count();
      assert(pillCount === 0, `expected 0 event pills in empty vault, got ${pillCount}`);
      // "My calendars" list should be entirely absent (CalendarList returns
      // null when calendars.length === 0 -- Sidebar.jsx line 77).
      const calList = await fl.locator('[aria-label="My calendars"]').count();
      console.log(`[agv2-1] "My calendars" group present with 0 calendars: ${calList > 0}`);
    });

    await step('flow3-empty-week', 'Switch to Week view -> empty grid, no events, no console errors', async () => {
      const fl = frameLoc(page);
      await fl.locator('#weekViewBtn, .kit-seg button', { hasText: 'Week' }).first().click();
      await page.waitForTimeout(400);
      await shot('04-empty-week-view');
      const weekCols = await fl.locator('.ag-week-col').count();
      assert(weekCols === 7, `expected 7 week columns, got ${weekCols}`);
    });

    await step('flow4-empty-schedule', 'Switch to Schedule view -> "Nothing coming up" empty state', async () => {
      const fl = frameLoc(page);
      await fl.locator('.kit-seg button', { hasText: 'Schedule' }).first().click();
      await page.waitForTimeout(400);
      await shot('05-empty-schedule-view');
      const emptyTitle = await fl.locator('.kit-empty-title').textContent().catch(() => '');
      assert(/Nothing coming up/.test(emptyTitle ?? ''), `expected "Nothing coming up" empty state, got: ${emptyTitle}`);
    });

    await step('flow5-create-modal-default-calendar', 'Create event modal on a fresh vault: the bootstrapped "Personal" calendar is pickable and Propose is enabled', async () => {
      // A fresh dev vault now bootstraps with a default "Personal" calendar
      // (gateway/vault bootstrap behavior — the old "zero calendars, import an
      // .ics" dead end this step used to assert no longer applies). So the
      // picker shows the calendar chip and Propose is enabled from the start;
      // the no-calendars hint is exercised only if a vault truly has none.
      const fl = frameLoc(page);
      await fl.locator('#createEventBtn, .ag-new', { hasText: 'Create event' }).first().click();
      const modal = fl.locator('.ag-create-modal');
      await modal.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300); // let kit's 0.18s fade-in/rise-lg modal animation settle
      await shot('06-create-modal-default-calendar');
      const calChips = await modal.locator('.ag-cal-chips:not(.ag-guest-chips) .ag-cal-chip').count();
      assert(calChips >= 1, `expected at least the bootstrapped calendar chip, got ${calChips}`);
      const proposeBtn = modal.getByRole('button', { name: 'Propose event' });
      assert(!(await proposeBtn.isDisabled()), 'Propose event should be enabled when a calendar exists');
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden', timeout: 5000 });
      await shot('07-create-modal-escaped');
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ AGENDA V2 SUITE 1 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(28)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('===================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);
    console.log(`\nuserDataDir preserved for suites 2-4: ${USER_DATA_DIR}`);

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll agenda-v2-suite-1 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, '1-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[agv2-1] FATAL — screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
    // NOTE: userDataDir intentionally NOT removed -- suites 2-4 reuse it.
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
