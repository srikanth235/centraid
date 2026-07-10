#!/usr/bin/env node
// Agenda v2 QA Suite 3: the crux of this pass.
//
// (A) Cancel-event "parks for owner confirmation" claim. app.json's own
//     description, the Agenda sidebar footer ("Cancelling parks for the
//     owner & is receipted."), and every line of app.jsx/logic.js/
//     EventDrawer.jsx (pendingCancelIds, "Ask to cancel" two-click arm,
//     kit-pending styling, "Cancellation pending" label, the toast "it
//     stays on the agenda until approved") are built around
//     `schedule.cancel_event` returning `status: 'parked'` for an app-scoped
//     caller. Source inspection of packages/vault/src/commands/schedule.ts
//     found NO `confirm: true` on CANCEL_EVENT (only `risk: 'medium'`) --
//     and packages/vault/src/gateway/types.ts documents that `risk` is only
//     a review-feed salience marker, parking is driven SOLELY by
//     `confirm: true`. This flow drives the real UI end to end to see which
//     is true in practice: does it actually park (Approvals gets an entry
//     to walk through), or does it execute immediately with no owner
//     confirmation at all despite every UI affordance promising one?
//     Same suspected defect applies to `schedule.reschedule_event` (also
//     risk:'medium', also no confirm:true) -- tested too.
//
// (B) The "upcoming lacks attendees" flag, taken further: since
//     upcoming.js/search.js never join schedule_attendee, the Guests/RSVP
//     UI can NEVER render for real through the app (confirmed in suite 2).
//     This suite proves the RSVP *write* path itself is NOT broken (refutes
//     the "rsvp.js schema mismatch" flag) by invoking
//     `window.centraid.write({action:'rsvp', ...})` directly against a
//     rig-seeded event+attendee row (seed-agenda-calendars.mjs), exactly
//     the shape rsvp.js forwards to `schedule.respond_rsvp`.
//
// PREREQ: run in order --
//   node tests/e2e-live/flows-agenda-v2-01-empty-install.mjs
//   node tests/e2e-live/seed-agenda-calendars.mjs tests/e2e-live/out/userdata-agenda-v2
//   node tests/e2e-live/flows-agenda-v2-02-propose-corner-cases.mjs
//   node tests/e2e-live/flows-agenda-v2-03-cancel-rsvp-attendees.mjs   <- this file
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
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-agv2-3-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `3-${name}.png`);
  await page.screenshot({ path: p });
  return p;
}

function frameLoc(p) {
  return p.frameLocator('iframe[data-centraid-app="1"]');
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const seedIds = JSON.parse(await fs.readFile(path.join(OUT_DIR, 'seed-ids.json'), 'utf8'));
  console.log('[agv2-3] loaded seed ids:', seedIds);

  const t0 = Date.now();
  session = await launchApp({ userDataDir: USER_DATA_DIR });
  page = session.page;
  wireConsole(page);
  page.setDefaultTimeout(60_000);
  console.log(`[agv2-3] launched + Home ready in ${Date.now() - t0}ms`);

  // Findings captured here surface verbatim in the final printed report.
  const findings = {};

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    const tile = page.locator('[data-app-id="agenda"]');
    await tile.getByTestId('app-tile').click();
    await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
    let fl = frameLoc(page);
    await fl.locator('.ag-brand-name', { hasText: 'Agenda' }).waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(800);

    await step('flow1-reschedule-outcome', 'Move "Design review sync" via the drawer -- observe whether reschedule_event ACTUALLY parks or executes immediately', async () => {
      await fl.locator('.kit-seg button', { hasText: 'Month' }).click();
      await page.waitForTimeout(300);
      await fl.locator('.ag-today', { hasText: 'Today' }).click();
      await page.waitForTimeout(300);
      const pill = fl.locator('.ag-pill', { hasText: 'Design review sync' });
      await pill.waitFor({ state: 'visible', timeout: 10_000 });
      await pill.click();
      const drawer = fl.locator('.ag-drawer');
      await drawer.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
      const startInput = drawer.locator('input[type="datetime-local"]').first();
      const currentStart = await startInput.inputValue();
      const newStart = currentStart.replace(/T(\d{2}):/, (m, h) => `T${String((Number(h) + 2) % 24).padStart(2, '0')}:`);
      await startInput.fill(newStart);
      await page.waitForTimeout(200);
      await drawer.getByRole('button', { name: 'Move event' }).click();
      await page.waitForTimeout(800);
      await shot('01-after-reschedule-attempt');

      // If it parked, the drawer stays open with a pending chip/kit-pending
      // treatment (per rescheduleEvent()'s `else if (outcome?.status ===
      // 'parked')` branch -- it does NOT close the drawer in that case,
      // only on 'executed'). If it executed, `onClose()` fires (per
      // EventDrawer's `submitReschedule`) and the drawer closes.
      const drawerStillOpen = await drawer.isVisible().catch(() => false);
      findings.rescheduleParked = drawerStillOpen;
      console.log(`[agv2-3] FINDING: reschedule drawer still open after Move (=parked, did NOT execute immediately): ${drawerStillOpen}`);
      if (drawerStillOpen) {
        await shot('01b-reschedule-parked-drawer-state');
        await fl.locator('[aria-label="Close"]').first().click();
      } else {
        // Executed immediately -- confirm the pill actually moved.
        await fl.locator('.kit-seg button', { hasText: 'Month' }).click().catch(() => undefined);
      }
    });

    await step('flow2-cancel-outcome', 'Ask-to-cancel an event -- observe whether cancel_event ACTUALLY parks (Approvals gets an entry) or executes immediately with no owner say-so', async () => {
      await fl.locator('.ag-today', { hasText: 'Today' }).click();
      await page.waitForTimeout(300);
      const pill = fl.locator('.ag-pill', { hasText: 'All-day offsite' });
      await pill.waitFor({ state: 'visible', timeout: 10_000 });
      await pill.click();
      const drawer = fl.locator('.ag-drawer');
      await drawer.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
      await shot('02-before-cancel-drawer');

      const cancelBtn = drawer.getByRole('button', { name: 'Ask to cancel' });
      await cancelBtn.click(); // arm
      await page.waitForTimeout(200);
      const armedText = await cancelBtn.textContent();
      console.log(`[agv2-3] armed cancel button text: ${JSON.stringify(armedText)}`);
      assert(/ask to cancel\?/i.test(armedText ?? ''), `expected armed label "Ask to cancel?", got ${armedText}`);
      await shot('03-cancel-armed');
      await cancelBtn.click(); // confirm
      await page.waitForTimeout(1000);
      await shot('04-after-cancel-confirm');

      const noticeText = await fl.locator('#noticeBanner').textContent().catch(() => '');
      console.log(`[agv2-3] noticeBanner text after cancel-confirm: ${JSON.stringify(noticeText)}`);
      const drawerStillOpen = await drawer.isVisible().catch(() => false);
      console.log(`[agv2-3] drawer still open after cancel-confirm: ${drawerStillOpen}`);

      findings.cancelParked = /waiting for your approval/i.test(noticeText ?? '');
      findings.cancelNoticeText = noticeText;
      console.log(`[agv2-3] FINDING: cancel_event actually PARKED: ${findings.cancelParked}`);

      if (!findings.cancelParked) {
        // Suspected: executed immediately. Verify the event actually
        // vanished (status flips to 'cancelled', and the upcoming/search
        // queries filter cancelled events out entirely -- see upcoming.js
        // `status != 'cancelled'`).
        await fl.locator('.kit-seg button', { hasText: 'Month' }).click().catch(() => undefined);
        await page.waitForTimeout(400);
        const stillThere = await fl.locator('.ag-pill', { hasText: 'All-day offsite' }).count();
        findings.cancelExecutedEventGone = stillThere === 0;
        console.log(`[agv2-3] FINDING: event gone from calendar immediately after "Ask to cancel" confirm (no owner review happened): ${stillThere === 0}`);
        await shot('05-month-view-after-immediate-cancel');
      }
    });

    await step('flow3-approvals-no-parked-cancel-entry', 'Approvals screen: check whether ANY schedule.cancel_event / reschedule_event entry is actually waiting there', async () => {
      await navTo(page, 'Approvals');
      await page.getByRole('heading', { name: 'Approvals', level: 1 }).waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(500);
      await shot('06-approvals-screen');
      const scheduleRows = await page.locator('text=/schedule\\.(cancel_event|reschedule_event)/').count();
      findings.approvalsHasScheduleEntries = scheduleRows > 0;
      console.log(`[agv2-3] FINDING: Approvals shows ${scheduleRows} schedule.cancel_event/reschedule_event row(s) (expected >0 only if the app.json/UI promise of parking is actually honored)`);
      const emptyState = await page.locator('text=Nothing waiting on you.').count();
      console.log(`[agv2-3] Approvals "Nothing waiting on you." empty state showing: ${emptyState > 0}`);
    });

    // ---- (B) RSVP / attendees ----

    await step('flow4-seeded-event-no-guests-in-ui', 'The rig-seeded event (real schedule_attendee row in the DB) STILL shows no Guests section in the drawer -- proves the gap is query-side, not data-side', async () => {
      // `[data-app-id="agenda"]` only exists on Home's app-grid card (absent
      // on the Approvals screen we just navigated to, per the same trap
      // documented in flows-approvals-02-corner-cases.mjs) -- use the
      // persistent left-rail sidebar item instead, present on every screen.
      await page.getByRole('button', { name: 'Agenda', exact: true }).first().click();
      await page.waitForSelector('iframe[data-centraid-app="1"]', { state: 'attached', timeout: 20_000 });
      fl = frameLoc(page);
      await fl.locator('.ag-brand-name', { hasText: 'Agenda' }).waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(600);
      await fl.locator('#searchInput').fill('SEEDED');
      await page.waitForTimeout(600);
      // The seeded event's dtstart is "now + 3 days" at whatever wall-clock
      // time the seed script ran -- if that happens to land near midnight,
      // it spans two day-groups in the Schedule view (two `.ag-sched-card`
      // segments for the same event, same as the overnight-event corner
      // case in suite 2), so scope to `.first()` rather than assume one.
      const card = fl.locator('.ag-sched-card', { hasText: 'SEEDED' }).first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      await card.click();
      const drawer = fl.locator('.ag-drawer');
      await drawer.waitFor({ state: 'visible', timeout: 5000 });
      await page.waitForTimeout(300);
      await shot('07-seeded-event-drawer-no-guests');
      const guestsLabel = await drawer.locator('text=Guests').count();
      assert(guestsLabel === 0, `expected NO Guests section even though schedule_attendee has a real row for this event (party ${seedIds.danaId}) -- proves upcoming.js/search.js never join attendees`);
      findings.seededEventAttendeeInvisibleInUI = true;
      await fl.locator('[aria-label="Close"]').first().click();
      await fl.locator('#searchInput').fill('');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    });

    await step('flow5-rsvp-direct-invoke-valid', 'Direct window.centraid.write({action:"rsvp"}) with the seeded, actually-invited party -- proves the WRITE path (rsvp.js -> schedule.respond_rsvp) is NOT broken, just unreachable via the real UI', async () => {
      const outcome = await fl.locator('body').evaluate(
        async (_el, args) => {
          return await window.centraid.write({
            action: 'rsvp',
            input: { event_id: args.eventId, party_id: args.partyId, partstat: 'accepted' },
          });
        },
        { eventId: seedIds.seededEventId, partyId: seedIds.danaId },
      );
      console.log(`[agv2-3] direct rsvp() outcome for a genuinely-invited party: ${JSON.stringify(outcome)}`);
      findings.rsvpValidOutcome = outcome;
      assert(outcome?.status === 'executed', `expected 'executed' for a real invited party -- got ${JSON.stringify(outcome)} (would indicate a REAL rsvp.js/schedule.respond_rsvp schema mismatch)`);
    });

    await step('flow6-rsvp-direct-invoke-not-invited', 'Direct rsvp() with a party NEVER invited to the event -- expect a clean "failed" (attendee_invited precondition), not a crash', async () => {
      const outcome = await fl.locator('body').evaluate(
        async (_el, args) => {
          return await window.centraid.write({
            action: 'rsvp',
            input: { event_id: args.eventId, party_id: args.partyId, partstat: 'accepted' },
          });
        },
        { eventId: seedIds.seededEventId, partyId: seedIds.ownerPartyId },
      );
      console.log(`[agv2-3] direct rsvp() outcome for a NON-invited party (owner): ${JSON.stringify(outcome)}`);
      findings.rsvpNotInvitedOutcome = outcome;
      assert(outcome?.status === 'failed', `expected 'failed' (attendee_invited precondition) for a non-invited party, got ${JSON.stringify(outcome)}`);
    });

    // ---- Report ----
    console.log('\n================ AGENDA V2 SUITE 3 KEY FINDINGS ================');
    console.log(JSON.stringify(findings, null, 2));
    console.log('===================================================================');

    const consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log('\n================ AGENDA V2 SUITE 3 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    console.log('===================================================================');
    console.log(`Console errors: ${consoleErrors.length}`);
    for (const e of consoleErrors) console.log(`  ERROR: ${e.text}`);

    await fs.writeFile(path.join(OUT_DIR, 'suite3-findings.json'), JSON.stringify(findings, null, 2));

    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll agenda-v2-suite-3 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, '3-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[agv2-3] FATAL — screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
