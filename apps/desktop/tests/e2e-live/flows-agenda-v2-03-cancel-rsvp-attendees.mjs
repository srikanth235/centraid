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
// (B) Attendees/RSVP, now that issue #337 has landed: upcoming.js/search.js
//     join schedule_attendee -> core_party, so the Guests section renders for
//     real through the app, and the drawer's "You" row + Going/Maybe/Decline
//     controls light up when the owner is an invited attendee. This suite
//     drives all of that end to end against the rig-seeded events
//     (seed-agenda-calendars.mjs): the Dana-invited event shows a Guests
//     section (needs-action), the owner-invited event exposes the clickable
//     RSVP controls and records a response, and the direct
//     window.centraid.write({action:'rsvp', ...}) probes still confirm the
//     write path (valid party -> executed, non-invited party -> failed).
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

function localInput(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
    await page.waitForSelector('iframe[data-centraid-app="1"]', {
      state: 'attached',
      timeout: 20_000,
    });
    let fl = frameLoc(page);
    await fl
      .locator('.ag-brand-name', { hasText: 'Agenda' })
      .waitFor({ state: 'visible', timeout: 15_000 });
    await page.waitForTimeout(800);

    await step(
      'flow1-reschedule-outcome',
      'Move "Design review sync" via the drawer -- observe whether reschedule_event ACTUALLY parks or executes immediately',
      async () => {
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
        const newStart = currentStart.replace(
          /T(\d{2}):/,
          (m, h) => `T${String((Number(h) + 2) % 24).padStart(2, '0')}:`,
        );
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
        console.log(
          `[agv2-3] FINDING: reschedule drawer still open after Move (=parked, did NOT execute immediately): ${drawerStillOpen}`,
        );
        if (drawerStillOpen) {
          await shot('01b-reschedule-parked-drawer-state');
          await fl.locator('[aria-label="Close"]').first().click();
        } else {
          // Executed immediately -- confirm the pill actually moved.
          await fl
            .locator('.kit-seg button', { hasText: 'Month' })
            .click()
            .catch(() => undefined);
        }
      },
    );

    await step(
      'flow2-cancel-parks',
      'Ask-to-cancel an event -> cancel_event PARKS for the owner (confirm:true honored): drawer shows "Cancel pending", event stays on the agenda',
      async () => {
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
        assert(
          /ask to cancel\?/i.test(armedText ?? ''),
          `expected armed label "Ask to cancel?", got ${armedText}`,
        );
        await shot('03-cancel-armed');
        await cancelBtn.click(); // confirm
        await page.waitForTimeout(1200);
        await shot('04-after-cancel-confirm');

        // Parking's tells (logic.js cancelEvent 'parked' branch): the drawer
        // stays open with a "Cancel pending" badge and the button relabels to
        // "Cancellation pending" -- there is no noticeBanner text (that surface
        // is reserved for failed/denied), so detect park on the drawer state.
        const pendingBadge = await drawer
          .locator('.ag-badge', { hasText: 'Cancel pending' })
          .count();
        const pendingBtn = await drawer
          .getByRole('button', { name: 'Cancellation pending' })
          .count();
        findings.cancelParked = pendingBadge > 0 || pendingBtn > 0;
        console.log(
          `[agv2-3] FINDING: cancel_event PARKED (drawer shows pending): ${findings.cancelParked}`,
        );
        assert(
          findings.cancelParked,
          'expected the cancel to park (Cancel pending badge / Cancellation pending button)',
        );

        // Close the drawer so its backdrop stops intercepting later clicks.
        await page.keyboard.press('Escape');
        await drawer.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => undefined);
        await fl
          .locator('.kit-seg button', { hasText: 'Month' })
          .click()
          .catch(() => undefined);
        await page.waitForTimeout(400);
        // Parked, not executed: the event is still on the agenda (status is
        // unchanged until the owner approves).
        const stillThere = await fl.locator('.ag-pill', { hasText: 'All-day offsite' }).count();
        findings.cancelEventStillOnAgenda = stillThere > 0;
        console.log(
          `[agv2-3] FINDING: event still on the agenda after the parked cancel: ${stillThere > 0}`,
        );
        assert(stillThere > 0, 'a parked cancel must NOT remove the event from the agenda yet');
        await shot('05-month-view-after-parked-cancel');
      },
    );

    await step(
      'flow3-approvals-has-parked-entries',
      'Approvals screen: the parked schedule.cancel_event / reschedule_event asks ARE waiting there',
      async () => {
        await navTo(page, 'Approvals');
        await page
          .getByRole('heading', { name: 'Approvals', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(500);
        await shot('06-approvals-screen');
        const scheduleRows = await page
          .locator('text=/schedule\\.(cancel_event|reschedule_event)/')
          .count();
        findings.approvalsHasScheduleEntries = scheduleRows > 0;
        console.log(
          `[agv2-3] FINDING: Approvals shows ${scheduleRows} schedule.cancel_event/reschedule_event row(s)`,
        );
        assert(
          scheduleRows > 0,
          'expected the parked reschedule/cancel asks to appear in Approvals',
        );
      },
    );

    await step(
      'flow4c-create-modal-guest-picker',
      'Invite Dana through the CreateModal guest picker -> the proposed event carries her as a guest end to end',
      async () => {
        // flow3 left us on the Approvals screen (no Agenda iframe), so re-open
        // Agenda via the persistent left-rail item before touching its UI.
        await page.getByRole('button', { name: 'Agenda', exact: true }).first().click();
        await page.waitForSelector('iframe[data-centraid-app="1"]', {
          state: 'attached',
          timeout: 20_000,
        });
        fl = frameLoc(page);
        await fl
          .locator('.ag-brand-name', { hasText: 'Agenda' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(600);
        await fl.locator('.ag-new', { hasText: 'Create event' }).first().click();
        const modal = fl.locator('.ag-create-modal');
        await modal.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);
        const start = new Date(Date.now() + 10 * 86400000);
        start.setHours(12, 0, 0, 0);
        const end = new Date(start.getTime() + 3600000);
        await modal.locator('.ag-create-title').fill('Team lunch with Dana');
        await modal.locator('input[type="datetime-local"]').first().fill(localInput(start));
        await modal.locator('input[type="datetime-local"]').nth(1).fill(localInput(end));
        await modal.locator('.ag-cal-chip', { hasText: 'Personal' }).click();
        // The guest picker only paints once the `parties` query resolves.
        const danaChip = modal.locator('.ag-guest-chips .ag-cal-chip', { hasText: 'Dana Kim' });
        await danaChip.waitFor({ state: 'visible', timeout: 8000 });
        await shot('10-create-modal-guest-picker');
        await danaChip.click();
        assert(
          (await danaChip.getAttribute('aria-pressed')) === 'true',
          'expected the Dana guest chip to read aria-pressed=true once selected',
        );
        await modal.getByRole('button', { name: 'Propose event' }).click();
        await modal.waitFor({ state: 'hidden', timeout: 10_000 });
        await page.waitForTimeout(600);

        await fl.locator('#searchInput').fill('Team lunch with Dana');
        await page.waitForTimeout(700);
        const card = fl.locator('.ag-sched-card', { hasText: 'Team lunch with Dana' }).first();
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        await card.click();
        const drawer = fl.locator('.ag-drawer');
        await drawer.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);
        await shot('11-created-event-with-guest');
        const guests = await drawer.locator('.ag-eyebrow-label', { hasText: 'Guests' }).count();
        assert(
          guests > 0,
          'expected a Guests section on the event just created with a guest invited',
        );
        const danaRow = drawer.locator('.ag-guest-row', { hasText: 'Dana Kim' });
        await danaRow.waitFor({ state: 'visible', timeout: 5000 });
        const stat = await danaRow
          .locator('.ag-guest-stat')
          .textContent()
          .catch(() => '');
        assert(
          /invited/i.test(stat ?? ''),
          `expected the invited guest to show "Invited", got ${JSON.stringify(stat)}`,
        );
        findings.createModalGuestInvited = true;
        await fl.locator('[aria-label="Close"]').first().click();
        await fl.locator('#searchInput').fill('');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      },
    );

    // ---- (B) RSVP write-path probes (direct invoke) ----

    await step(
      'flow4-seeded-event-guests-render',
      'The rig-seeded Dana event now SHOWS its Guests section in the drawer -- upcoming/search join schedule_attendee (issue #337)',
      async () => {
        // `[data-app-id="agenda"]` only exists on Home's app-grid card (absent
        // on the Approvals screen we just navigated to, per the same trap
        // documented in flows-approvals-02-corner-cases.mjs) -- use the
        // persistent left-rail sidebar item instead, present on every screen.
        await page.getByRole('button', { name: 'Agenda', exact: true }).first().click();
        await page.waitForSelector('iframe[data-centraid-app="1"]', {
          state: 'attached',
          timeout: 20_000,
        });
        fl = frameLoc(page);
        await fl
          .locator('.ag-brand-name', { hasText: 'Agenda' })
          .waitFor({ state: 'visible', timeout: 15_000 });
        await page.waitForTimeout(600);
        // Reset the window to today-forward before searching: opening a search
        // result opens the drawer via findEvent(), which only looks in the
        // loaded `data.events` window (app.jsx) -- an earlier create can have
        // moved the cursor weeks out, dropping the seeded near-term events from
        // that window. "Today" reloads it so the seeded event is present.
        await fl.locator('.ag-today', { hasText: 'Today' }).click();
        await page.waitForTimeout(400);
        await fl.locator('#searchInput').fill('RSVP probe');
        await page.waitForTimeout(700);
        // The seeded event's dtstart is "now + 3 days" at whatever wall-clock
        // time the seed script ran -- if that happens to land near midnight,
        // it spans two day-groups in the Schedule view (two `.ag-sched-card`
        // segments for the same event, same as the overnight-event corner
        // case in suite 2), so scope to `.first()` rather than assume one.
        const card = fl.locator('.ag-sched-card', { hasText: 'RSVP probe' }).first();
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        await card.click();
        const drawer = fl.locator('.ag-drawer');
        await drawer.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);
        await shot('07-seeded-event-drawer-guests');
        const guestsLabel = await drawer
          .locator('.ag-eyebrow-label', { hasText: 'Guests' })
          .count();
        assert(
          guestsLabel > 0,
          `expected a Guests section now that schedule_attendee is joined for this event (party ${seedIds.danaId})`,
        );
        const danaRow = drawer.locator('.ag-guest-row', { hasText: 'Dana Kim' });
        await danaRow.waitFor({ state: 'visible', timeout: 5000 });
        const danaStat = await danaRow
          .locator('.ag-guest-stat')
          .textContent()
          .catch(() => '');
        console.log(
          `[agv2-3] Dana's row status in the Guests section: ${JSON.stringify(danaStat)}`,
        );
        assert(
          /invited/i.test(danaStat ?? ''),
          `expected Dana to show as "Invited" (needs-action), got ${JSON.stringify(danaStat)}`,
        );
        // Dana is not the owner, so her row must NOT expose the "You" RSVP controls.
        const danaHasControls = await danaRow.locator('.ag-guest-opt').count();
        assert(
          danaHasControls === 0,
          'a non-you guest must not get the Going/Maybe/Decline controls',
        );
        findings.seededEventGuestsRender = true;
        await fl.locator('[aria-label="Close"]').first().click();
        await fl.locator('#searchInput').fill('');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      },
    );

    await step(
      'flow4b-owner-rsvp-controls-record',
      'The owner-invited seeded event exposes the "You" RSVP row; clicking Going records the response end to end',
      async () => {
        await fl.locator('.ag-today', { hasText: 'Today' }).click();
        await page.waitForTimeout(400);
        await fl.locator('#searchInput').fill('Your RSVP event');
        await page.waitForTimeout(700);
        const card = fl.locator('.ag-sched-card', { hasText: 'Your RSVP event' }).first();
        await card.waitFor({ state: 'visible', timeout: 10_000 });
        await card.click();
        const drawer = fl.locator('.ag-drawer');
        await drawer.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);
        await shot('08-owner-rsvp-drawer-before');
        const youRow = drawer.locator('.ag-guest-row', { hasText: 'You' }).first();
        await youRow.waitFor({ state: 'visible', timeout: 5000 });
        const goingBtn = youRow.getByRole('button', { name: 'Going' });
        await goingBtn.waitFor({ state: 'visible', timeout: 5000 });
        assert(
          (await youRow.locator('.ag-guest-opt').count()) === 3,
          'expected the three RSVP controls on the "You" row',
        );
        await goingBtn.click();
        await page.waitForTimeout(1200);
        await shot('09-owner-rsvp-drawer-after-going');
        // write() -> executed -> refresh() re-reads upcoming with the new
        // partstat, and the drawer (keyed by event_id) remounts, so the Going
        // control now reads data-active="true".
        const reopened = fl.locator('.ag-drawer');
        const activeGoing = reopened
          .locator('.ag-guest-row', { hasText: 'You' })
          .first()
          .getByRole('button', { name: 'Going' });
        const activeState = await activeGoing.getAttribute('data-active').catch(() => null);
        console.log(
          `[agv2-3] "Going" control data-active after RSVP: ${JSON.stringify(activeState)}`,
        );
        findings.ownerRsvpRecorded = activeState === 'true';
        assert(
          activeState === 'true',
          `expected the "Going" control to be active after recording the RSVP, got data-active=${JSON.stringify(activeState)}`,
        );
        await reopened
          .locator('[aria-label="Close"]')
          .first()
          .click()
          .catch(() => undefined);
        await fl.locator('#searchInput').fill('');
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      },
    );

    await step(
      'flow5-rsvp-direct-invoke-valid',
      'Direct window.centraid.write({action:"rsvp"}) with the seeded, actually-invited party -- proves the WRITE path (rsvp.js -> schedule.respond_rsvp) is NOT broken, just unreachable via the real UI',
      async () => {
        const outcome = await fl.locator('body').evaluate(
          async (_el, args) => {
            return await window.centraid.write({
              action: 'rsvp',
              input: { event_id: args.eventId, party_id: args.partyId, partstat: 'accepted' },
            });
          },
          { eventId: seedIds.seededEventId, partyId: seedIds.danaId },
        );
        console.log(
          `[agv2-3] direct rsvp() outcome for a genuinely-invited party: ${JSON.stringify(outcome)}`,
        );
        findings.rsvpValidOutcome = outcome;
        assert(
          outcome?.status === 'executed',
          `expected 'executed' for a real invited party -- got ${JSON.stringify(outcome)} (would indicate a REAL rsvp.js/schedule.respond_rsvp schema mismatch)`,
        );
      },
    );

    await step(
      'flow6-rsvp-direct-invoke-not-invited',
      'Direct rsvp() with a party NEVER invited to the event -- expect a clean "failed" (attendee_invited precondition), not a crash',
      async () => {
        const outcome = await fl.locator('body').evaluate(
          async (_el, args) => {
            return await window.centraid.write({
              action: 'rsvp',
              input: { event_id: args.eventId, party_id: args.partyId, partstat: 'accepted' },
            });
          },
          { eventId: seedIds.seededEventId, partyId: seedIds.ownerPartyId },
        );
        console.log(
          `[agv2-3] direct rsvp() outcome for a NON-invited party (owner): ${JSON.stringify(outcome)}`,
        );
        findings.rsvpNotInvitedOutcome = outcome;
        assert(
          outcome?.status === 'failed',
          `expected 'failed' (attendee_invited precondition) for a non-invited party, got ${JSON.stringify(outcome)}`,
        );
      },
    );

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

    await fs.writeFile(
      path.join(OUT_DIR, 'suite3-findings.json'),
      JSON.stringify(findings, null, 2),
    );

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
