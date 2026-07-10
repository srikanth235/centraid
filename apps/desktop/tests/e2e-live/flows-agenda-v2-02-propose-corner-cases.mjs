#!/usr/bin/env node
// Agenda v2 QA Suite 2: regular propose flow + view rendering, plus corner
// cases -- all-day, overnight-spanning, long/emoji/special-char titles,
// past events, same-calendar AND cross-calendar overlap/conflict handling,
// invalid date input, Escape-mid-form, rapid double-click on both "Create
// event" and "Propose event". Runs against the userDataDir suite 1 left
// behind, AFTER seed-agenda-calendars.mjs has minted two calendars into it
// (a fresh vault has zero schedule_calendar rows and no in-app way to
// create one -- see that script's header comment; this is a confirmed bug,
// reported separately, not something suite 2 can work around any other way).
//
// Run with:
//   node tests/e2e-live/seed-agenda-calendars.mjs tests/e2e-live/out/userdata-agenda-v2
//   node tests/e2e-live/flows-agenda-v2-02-propose-corner-cases.mjs
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-agv2-2-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `2-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

/** yyyy-MM-ddTHH:mm in the LOCAL timezone (what datetime-local inputs want). */
function localInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function openCreateModal(fl) {
  await fl.locator('.ag-new', { hasText: 'Create event' }).first().click();
  const modal = fl.locator('.ag-create-modal');
  await modal.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForTimeout(300); // let kit's 0.18s modal animation settle
  return modal;
}

async function fillAndSubmit(modal, { title, start, end, calendarName, description }) {
  if (title !== undefined) await modal.locator('.ag-create-title').fill(title);
  if (start) await modal.locator('input[type="datetime-local"]').first().fill(localInput(start));
  if (end) await modal.locator('input[type="datetime-local"]').nth(1).fill(localInput(end));
  if (calendarName) await modal.locator('.ag-cal-chip', { hasText: calendarName }).click();
  if (description !== undefined) await modal.locator('.ag-create-desc').fill(description);
  await modal.getByRole('button', { name: 'Propose event' }).click();
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[agv2-2] launched + Home ready in ${Date.now() - t0}ms`);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    const tile = page.locator('[data-app-id="agenda"]');
    await tile.getByTestId('app-tile').click();
    await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
    let fl = frameLoc(page);
    await fl.locator('.ag-brand-name', { hasText: 'Agenda' }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(800); // first `upcoming` read

    await step('flow1-two-calendars-visible', 'Seeded Personal+Work calendars show in "My calendars" sidebar', async () => {
      const rows = fl.locator('.ag-cal-row');
      await rows.first().waitFor({ state: 'visible', timeout: 10_000 });
      const count = await rows.count();
      assert(count === 2, `expected 2 calendars in sidebar, got ${count}`);
      await shot('01-two-calendars-sidebar');
    });

    let normalEventTitle;
    await step('flow2-propose-normal-event', 'Propose a normal timed event today on Personal -> lands tentative, pill visible', async () => {
      const modal = await openCreateModal(fl);
      const start = new Date();
      start.setHours(14, 0, 0, 0);
      const end = new Date(start.getTime() + 3600000);
      normalEventTitle = 'Design review sync';
      await shot('02-create-modal-filled-before-submit');
      await fillAndSubmit(modal, { title: normalEventTitle, start, end, calendarName: 'Personal' });
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(500);
      const toast = fl.locator('kit-toast, .kit-toasts');
      const toastText = await toast.textContent().catch(() => '');
      console.log(`[agv2-2] toast after propose: ${JSON.stringify(toastText)}`);
      await shot('03-month-view-with-normal-event');
      const pill = fl.locator('.ag-pill', { hasText: normalEventTitle });
      await pill.waitFor({ state: 'visible', timeout: 10_000 });
      const status = await pill.getAttribute('data-status');
      assert(status === 'tentative', `expected proposed event to be tentative, got ${status}`);
    });

    await step('flow3-event-detail-drawer-no-guests', 'Open event detail: no Guests section (attendees never joined by upcoming.js)', async () => {
      const pill = fl.locator('.ag-pill', { hasText: normalEventTitle });
      await pill.click();
      const drawer = fl.locator('.ag-drawer');
      await drawer.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
      await shot('04-event-drawer-normal');
      const guestsLabel = await drawer.locator('text=Guests').count();
      console.log(`[agv2-2] "Guests" eyebrow present: ${guestsLabel > 0} (expected 0 -- confirms upcoming.js never returns attendees)`);
      assert(guestsLabel === 0, 'expected NO Guests section since upcoming.js never joins schedule_attendee');
      await fl.locator('[aria-label="Close"]').first().click();
      await drawer.waitFor({ state: 'hidden', timeout: 5000 });
    });

    await step('flow4-all-day-event', 'Propose an all-day event (midnight-to-midnight) -> renders as a spanning bar, not a timed pill', async () => {
      const modal = await openCreateModal(fl);
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 5, 0, 0, 0);
      const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 6, 0, 0, 0);
      await fillAndSubmit(modal, { title: 'All-day offsite', start, end, calendarName: 'Work' });
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('05-all-day-event-month');
      const pill = fl.locator('.ag-pill', { hasText: 'All-day offsite' });
      await pill.waitFor({ state: 'visible', timeout: 10_000 });
      const spans = await pill.getAttribute('data-spans');
      assert(spans === 'true', `expected data-spans="true" for a midnight-to-midnight event, got ${spans}`);
    });

    await step('flow5-overnight-event', 'Propose an overnight event (10pm today -> 1am tomorrow) -> spans two day cells in month view', async () => {
      const modal = await openCreateModal(fl);
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 10, 22, 0, 0);
      const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 11, 1, 0, 0);
      await fillAndSubmit(modal, { title: 'Overnight watch shift', start, end, calendarName: 'Personal' });
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('06-overnight-event-month');
      const occurrences = await fl.locator('.ag-pill', { hasText: 'Overnight watch shift' }).count();
      assert(occurrences === 2, `expected the overnight event to render on both its start and end day cells, got ${occurrences}`);
    });

    await step('flow6-long-emoji-title', 'Propose events with a very long title and an emoji/special-char/HTML-ish title -> render safely, no layout break, no XSS', async () => {
      const longTitle = 'Q3 cross-functional stakeholder alignment and roadmap prioritization deep-dive with the entire extended leadership team and outside counsel'.slice(0, 180);
      const modal1 = await openCreateModal(fl);
      const today = new Date();
      const s1 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2, 9, 0, 0);
      const e1 = new Date(s1.getTime() + 1800000);
      await fillAndSubmit(modal1, { title: longTitle, start: s1, end: e1, calendarName: 'Personal' });
      await modal1.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(400);

      const emojiTitle = '🎉 Launch <script>alert(1)</script> & "quotes" party';
      const modal2 = await openCreateModal(fl);
      const s2 = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 2, 11, 0, 0);
      const e2 = new Date(s2.getTime() + 1800000);
      await fillAndSubmit(modal2, { title: emojiTitle, start: s2, end: e2, calendarName: 'Personal' });
      await modal2.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(400);
      await shot('07-long-and-emoji-titles-month');

      const emojiPill = fl.locator('.ag-pill', { hasText: '🎉 Launch' });
      await emojiPill.waitFor({ state: 'visible', timeout: 10_000 });
      const renderedText = await emojiPill.textContent();
      assert(renderedText?.includes('<script>'), 'expected the literal <script> text to render as inert text, not execute');
      // No actual alert dialog should have fired (React escapes text content by default).
      console.log(`[agv2-2] emoji pill text (should be literal, inert): ${JSON.stringify(renderedText)}`);

      // Also open the long-title event's drawer -- verify it doesn't overflow/clip catastrophically.
      const longPill = fl.locator('.ag-pill', { hasText: 'Q3 cross-functional' });
      await longPill.click();
      const drawer = fl.locator('.ag-drawer');
      await drawer.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
      await shot('08-long-title-drawer');
      await fl.locator('[aria-label="Close"]').first().click();
      await drawer.waitFor({ state: 'hidden', timeout: 5000 });
    });

    await step('flow7-past-event', 'Propose a past event (yesterday) -> month view (explicit range) still shows it', async () => {
      const modal = await openCreateModal(fl);
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1, 15, 0, 0);
      const end = new Date(start.getTime() + 3600000);
      await fillAndSubmit(modal, { title: 'Yesterday retro', start, end, calendarName: 'Personal' });
      await modal.waitFor({ state: 'hidden', timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('09-past-event-month');
      const pastPill = fl.locator('.ag-pill', { hasText: 'Yesterday retro' });
      const count = await pastPill.count();
      assert(count === 1, `expected the past event to render in month view (in-month range), got ${count}`);

      // NOTE: submitCreate() jumps `state.cursor` to the newly-proposed
      // event's own date (app.jsx `state.cursor = new Date(payload.dtstart)`)
      // -- a deliberate "jump to what you just created" UX choice, but it
      // means the Schedule view's `from` (which is `scheduleFrom(cursor)`,
      // not "true today") would now start at YESTERDAY if we didn't reset
      // it. Click "Today" first so this checks the real forward-looking
      // filter, not an artifact of the cursor having moved into the past.
      await fl.locator('.ag-today', { hasText: 'Today' }).click();
      await page.waitForTimeout(400);

      // Now check the Schedule (upcoming/list) view, which defaults `from`
      // to the START of today -- a purely-past event should NOT appear there.
      await fl.locator('.kit-seg button', { hasText: 'Schedule' }).click();
      await page.waitForTimeout(500);
      await shot('10-schedule-view-past-event-hidden');
      const scheduleCount = await fl.locator('.ag-sched-card', { hasText: 'Yesterday retro' }).count();
      console.log(`[agv2-2] "Yesterday retro" visible in Schedule (upcoming-only) view: ${scheduleCount > 0} (expected false)`);
      assert(scheduleCount === 0, 'a purely-past event should not appear in the forward-looking Schedule view');
      await fl.locator('.kit-seg button', { hasText: 'Month' }).click();
      await page.waitForTimeout(400);
    });

    await step('flow8-same-calendar-conflict-refused', 'Propose an event overlapping an EXISTING one on the SAME calendar -> vault refuses (failed, precondition no_busy_conflict)', async () => {
      const modal = await openCreateModal(fl);
      const today = new Date();
      // Overlaps flow2's 2pm-3pm "Design review sync" on Personal.
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 14, 30, 0);
      const end = new Date(start.getTime() + 3600000);
      await fillAndSubmit(modal, { title: 'Conflicting same-cal meeting', start, end, calendarName: 'Personal' });
      await page.waitForTimeout(600);
      await shot('11-same-calendar-conflict-notice');
      const notice = modal.locator('.ag-form-notice');
      const noticeText = await notice.textContent().catch(() => '');
      console.log(`[agv2-2] conflict notice text: ${JSON.stringify(noticeText)}`);
      assert(/refused|conflict|busy/i.test(noticeText ?? ''), `expected a vault-refused conflict message, got: ${noticeText}`);
      // Modal should still be open (proposal did not silently succeed).
      const stillOpen = await modal.isVisible();
      assert(stillOpen, 'modal should remain open after a refused proposal so the user can adjust');
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    });

    await step('flow9-cross-calendar-conflict-also-refused', 'Propose an overlapping event on a DIFFERENT calendar (Work) -> ALSO refused (conflict check is vault-wide, not per-calendar)', async () => {
      const modal = await openCreateModal(fl);
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 14, 15, 0);
      const end = new Date(start.getTime() + 3600000);
      await fillAndSubmit(modal, { title: 'Cross-calendar conflict test', start, end, calendarName: 'Work' });
      await page.waitForTimeout(600);
      await shot('12-cross-calendar-conflict-notice');
      const notice = modal.locator('.ag-form-notice');
      const noticeText = await notice.textContent().catch(() => '');
      console.log(`[agv2-2] cross-calendar conflict notice: ${JSON.stringify(noticeText)}`);
      assert(/refused|conflict|busy/i.test(noticeText ?? ''), `expected the SAME vault-wide conflict refusal across calendars, got: ${noticeText}`);
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    });

    await step('flow10-invalid-end-before-start', 'Client-side validation: end before start blocks submit with inline notice, no vault round-trip', async () => {
      const modal = await openCreateModal(fl);
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 15, 10, 0, 0);
      const end = new Date(start.getTime() - 3600000); // 1h BEFORE start
      await modal.locator('.ag-create-title').fill('Backwards time event');
      await modal.locator('input[type="datetime-local"]').first().fill(localInput(start));
      await modal.locator('input[type="datetime-local"]').nth(1).fill(localInput(end));
      await modal.locator('.ag-cal-chip', { hasText: 'Personal' }).click();
      await modal.getByRole('button', { name: 'Propose event' }).click();
      await page.waitForTimeout(300);
      await shot('13-invalid-end-before-start');
      const notice = await modal.locator('.ag-form-notice').textContent().catch(() => '');
      assert(/later end/i.test(notice ?? ''), `expected "Pick a start and a later end." notice, got: ${notice}`);
      const stillOpen = await modal.isVisible();
      assert(stillOpen, 'modal should remain open on client-side validation failure');
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    });

    await step('flow11-escape-mid-form-discards', 'Escape mid-form discards the draft -- reopening shows a blank composer', async () => {
      const modal = await openCreateModal(fl);
      await modal.locator('.ag-create-title').fill('Should be discarded');
      await page.keyboard.press('Escape');
      await modal.waitFor({ state: 'hidden', timeout: 5000 });
      const modal2 = await openCreateModal(fl);
      const titleVal = await modal2.locator('.ag-create-title').inputValue();
      assert(titleVal === '', `expected a blank title after Escape-discard + reopen, got: ${JSON.stringify(titleVal)}`);
      await shot('14-escape-then-reopen-blank');
      await page.keyboard.press('Escape');
      await modal2.waitFor({ state: 'hidden', timeout: 5000 });
    });

    await step('flow12-rapid-double-click-create-btn', 'Rapid double-click "Create event" opens exactly one modal, not two stacked', async () => {
      const btn = fl.locator('.ag-new', { hasText: 'Create event' }).first();
      // Two SYNCHRONOUS click() dispatches in one JS tick -- a genuine race
      // test. Doing this via two separate Playwright .click() calls doesn't
      // work: the first click opens a full-viewport modal backdrop
      // (.kit-modal-back, z-index 70) that covers the sidebar's "Create
      // event" button, so a second Playwright-level click (even forced)
      // lands on the backdrop instead and closes the modal via its own
      // click-outside handler -- a false "race" signal, not the real one.
      await btn.evaluate((el) => {
        el.click();
        el.click();
      });
      await page.waitForTimeout(300);
      const modalCount = await fl.locator('.ag-create-modal').count();
      assert(modalCount === 1, `expected exactly 1 create modal after rapid double-click, got ${modalCount}`);
      await shot('15-rapid-doubleclick-single-modal');
      await page.keyboard.press('Escape');
      await fl.locator('.ag-create-modal').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
    });

    await step('flow13-rapid-doubleclick-submit-no-dupe', 'Rapid double-click "Propose event" does not create a duplicate event', async () => {
      const modal = await openCreateModal(fl);
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 20, 9, 0, 0);
      const end = new Date(start.getTime() + 1800000);
      const title = 'Dupe-click guard test';
      await modal.locator('.ag-create-title').fill(title);
      await modal.locator('input[type="datetime-local"]').first().fill(localInput(start));
      await modal.locator('input[type="datetime-local"]').nth(1).fill(localInput(end));
      await modal.locator('.ag-cal-chip', { hasText: 'Personal' }).click();
      const submitBtn = modal.getByRole('button', { name: 'Propose event' });
      // Same synchronous-double-click technique as flow12 -- two Playwright
      // .click() calls in a Promise.all hang forever here: the first click's
      // successful outcome closes the modal (detaching the button) before
      // the second .click()'s actionability-retry loop ever gets a turn,
      // so it waits the full default timeout for an element that will never
      // reappear.
      await submitBtn.evaluate((el) => {
        el.click();
        el.click();
      });
      await page.waitForTimeout(1200);
      await fl.locator('.ag-create-modal').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
      await fl.locator('.kit-seg button', { hasText: 'Schedule' }).click();
      await page.waitForTimeout(400);
      await shot('16-dupe-click-schedule-view');
      const count = await fl.locator('.ag-sched-card', { hasText: title }).count();
      console.log(`[agv2-2] "${title}" card count after rapid double-submit: ${count}`);
      assert(count === 1, `expected exactly 1 event from a rapid double-submit, got ${count} (possible duplicate-write bug)`);
    });

    await step('flow14-search-finds-events', 'Search box finds a proposed event by title (FTS5), routes to Schedule view', async () => {
      await fl.locator('.kit-seg button', { hasText: 'Month' }).click();
      await page.waitForTimeout(300);
      await fl.locator('#searchInput').fill('Design review');
      await page.waitForTimeout(600); // debounce (200ms) + vault round-trip
      await shot('17-search-results');
      const hit = fl.locator('.ag-sched-card', { hasText: 'Design review sync' });
      await hit.waitFor({ state: 'visible', timeout: 10_000 });
      await fl.locator('#searchInput').fill('');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    });

    // ---- Report ----
    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ AGENDA V2 SUITE 2 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
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
      console.log('\nAll agenda-v2-suite-2 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, '2-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[agv2-2] FATAL — screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
