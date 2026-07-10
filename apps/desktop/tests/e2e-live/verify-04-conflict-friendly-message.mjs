#!/usr/bin/env node
// Verify fix #4: schedule.propose_event's preconditions now carry an
// owner-facing `message` (packages/vault/src/commands/schedule.ts +
// gateway/execution.ts's denyContract now prefers spec.message over the raw
// `name: column op value` predicate). Create two overlapping events on the
// same calendar and confirm the conflict refusal reads as a friendly
// sentence, not "no_busy_conflict: n eq 0".
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-04');

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
    results.push({ id, label, verdict: 'fail', ms: Date.now() - t0, error: err?.stack ?? String(err) });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v04-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v04-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

function localInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openCreateModal(fl) {
  await fl.locator('.ag-new', { hasText: 'Create event' }).first().click();
  const modal = fl.locator('.ag-create-modal');
  await modal.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300);
  return modal;
}

async function fillAndSubmit(modal, { title, start, end, calendarName }) {
  if (title !== undefined) await modal.locator('.ag-create-title').fill(title);
  if (start) await modal.locator('input[type="datetime-local"]').first().fill(localInput(start));
  if (end) await modal.locator('input[type="datetime-local"]').nth(1).fill(localInput(end));
  if (calendarName) await modal.locator('.ag-cal-chip', { hasText: calendarName }).click();
  await modal.getByRole('button', { name: 'Propose event' }).click();
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  await fs.rm(USER_DATA_DIR, { recursive: true, force: true });
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  page.setDefaultTimeout(60_000);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });

    await step('install-agenda', 'Discover -> install Agenda', async () => {
      await navTo(page, 'Discover');
      const card = page.locator('button[data-kind="app"]', { hasText: 'Agenda' }).first();
      await card.waitFor({ state: 'visible', timeout: 20_000 });
      await card.click();
      const dialog = page.getByRole('dialog', { name: /^Preview Agenda/ });
      await dialog.waitFor({ state: 'visible', timeout: 10_000 });
      await dialog.getByRole('button', { name: 'Use this template' }).click();
      await page.locator('[data-app-id="agenda"]').waitFor({ state: 'visible', timeout: 15_000 });
    });

    let fl;
    await step('open-agenda', 'Open Agenda iframe', async () => {
      await page.locator('[data-app-id="agenda"]').getByTestId('app-tile').click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
      fl = frameLoc(page);
      await fl.locator('.ag-brand-name', { hasText: 'Agenda' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(800);
    });

    const today = new Date();
    const firstStart = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 14, 0, 0);
    const firstEnd = new Date(firstStart.getTime() + 3600_000);
    const overlapStart = new Date(firstStart.getTime() + 30 * 60_000);
    const overlapEnd = new Date(overlapStart.getTime() + 3600_000);

    await step('propose-first-event', 'Propose "Conflict base meeting" 2-3pm on Personal', async () => {
      const modal = await openCreateModal(fl);
      await fillAndSubmit(modal, { title: 'Conflict base meeting', start: firstStart, end: firstEnd, calendarName: 'Personal' });
      await page.waitForTimeout(700);
      await fl.locator('.ag-pill', { hasText: 'Conflict base meeting' }).waitFor({ state: 'visible', timeout: 10_000 });
      await shot('01-base-meeting-proposed');
    });

    await step('propose-overlapping-friendly-refusal', 'Propose an OVERLAPPING event on the same calendar -- friendly sentence, not raw predicate', async () => {
      const modal = await openCreateModal(fl);
      await fillAndSubmit(modal, { title: 'Overlapping meeting', start: overlapStart, end: overlapEnd, calendarName: 'Personal' });
      await page.waitForTimeout(700);
      await shot('02-overlap-refused');

      const notice = modal.locator('.ag-form-notice');
      const noticeText = await notice.textContent().catch(() => '');
      console.log(`[v04] conflict notice text: ${JSON.stringify(noticeText)}`);

      assert(
        /this time conflicts with another event on your calendar/i.test(noticeText ?? ''),
        `expected the friendly sentence "This time conflicts with another event on your calendar.", got: ${JSON.stringify(noticeText)}`,
      );
      assert(
        !/no_busy_conflict/i.test(noticeText ?? '') && !/\beq\b/i.test(noticeText ?? ''),
        `raw precondition string leaked into the UI: ${JSON.stringify(noticeText)}`,
      );

      const stillOpen = await modal.isVisible();
      assert(stillOpen, 'modal should remain open after a refused proposal');
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);

      // Confirm the overlapping event was NOT actually created.
      const overlapCount = await fl.locator('.ag-pill', { hasText: 'Overlapping meeting' }).count();
      assert(overlapCount === 0, 'the conflicting event must not have been created');
    });

    // ---- Report ----
    console.log('\n================ VERIFY-04 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-04 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v04-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v04] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
