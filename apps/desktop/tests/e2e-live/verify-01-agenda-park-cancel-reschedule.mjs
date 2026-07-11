#!/usr/bin/env node
// Verify fix #1: schedule.cancel_event / reschedule_event now carry
// confirm:true (packages/vault/src/commands/schedule.ts) so they PARK for
// owner confirmation instead of executing immediately under the app's
// install-time grant. Also spot-checks fix #3 in passing (fresh vault
// mints a default "Personal" calendar via bootstrap.ts, so the create-event
// modal is never a dead end).
//
// Flow: fresh vault -> install Agenda -> propose two events -> ask-to-cancel
// one (arm+confirm) -> expect "waiting for your approval" notice, event
// still present -> Approvals lists it -> approve -> event actually cancels.
// -> reschedule the other event -> expect it PARKS (drawer stays open, event
// does not move) rather than executing immediately.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchApp, navTo } from './driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, 'out', 'verify');
const USER_DATA_DIR = path.join(__dirname, 'out', 'verify-userdata-01');

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
    results.push({
      id,
      label,
      verdict: 'fail',
      ms: Date.now() - t0,
      error: err?.stack ?? String(err),
    });
    console.error(`[FAIL] ${id} ${label}: ${err}`);
    try {
      await page.screenshot({ path: path.join(OUT_DIR, `FAIL-v01-${id}.png`) });
    } catch {
      /* ignore */
    }
  }
}

async function shot(name) {
  const p = path.join(OUT_DIR, `v01-${name}.png`);
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
      await page.waitForSelector('iframe[data-centraid-app="1"]', {
        state: 'attached',
        timeout: 20_000,
      });
      fl = frameLoc(page);
      await fl
        .locator('.ag-brand-name', { hasText: 'Agenda' })
        .waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(800);
    });

    await step(
      'fix3-default-calendar-present',
      'Fresh vault already has a "Personal" calendar -- create modal is not a dead end (fix #3)',
      async () => {
        const modal = await openCreateModal(fl);
        await shot('01-create-modal-fresh-vault');
        const calChip = modal.locator('.ag-cal-chip', { hasText: 'Personal' });
        const calChipCount = await calChip.count();
        assert(
          calChipCount >= 1,
          `expected a "Personal" calendar chip in the create modal on a brand-new vault, found ${calChipCount}`,
        );
        const noCalMsg = await modal.locator('text=import an .ics file').count();
        assert(
          noCalMsg === 0,
          'expected NO "no calendars, import an .ics" dead-end hint now that a default calendar is minted',
        );
        await page.keyboard.press('Escape');
        await modal.waitFor({ state: 'hidden', timeout: 5000 });
      },
    );

    const now = new Date();
    const alphaStart = new Date(now.getTime() + 2 * 3600_000);
    const alphaEnd = new Date(now.getTime() + 3 * 3600_000);
    const betaStart = new Date(now.getTime() + 5 * 3600_000);
    const betaEnd = new Date(now.getTime() + 6 * 3600_000);

    await step('propose-alpha', 'Propose "Verify Alpha (cancel target)" on Personal', async () => {
      const modal = await openCreateModal(fl);
      await fillAndSubmit(modal, {
        title: 'Verify Alpha (cancel target)',
        start: alphaStart,
        end: alphaEnd,
        calendarName: 'Personal',
      });
      await page.waitForTimeout(800);
      await fl.locator('.kit-seg button', { hasText: 'Month' }).click();
      await page.waitForTimeout(300);
      await fl.locator('.ag-today', { hasText: 'Today' }).click();
      await page.waitForTimeout(300);
      await fl
        .locator('.ag-pill', { hasText: 'Verify Alpha' })
        .waitFor({ state: 'visible', timeout: 10_000 });
      await shot('02-alpha-proposed');
    });

    await step(
      'propose-beta',
      'Propose "Verify Beta (reschedule target)" on Personal',
      async () => {
        const modal = await openCreateModal(fl);
        await fillAndSubmit(modal, {
          title: 'Verify Beta (reschedule target)',
          start: betaStart,
          end: betaEnd,
          calendarName: 'Personal',
        });
        await page.waitForTimeout(800);
        await fl
          .locator('.ag-pill', { hasText: 'Verify Beta' })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await shot('03-beta-proposed');
      },
    );

    await step(
      'cancel-parks-not-executes',
      'Ask-to-cancel Alpha -- must PARK (notice says waiting for approval), event stays',
      async () => {
        const pill = fl.locator('.ag-pill', { hasText: 'Verify Alpha' });
        await pill.click();
        const drawer = fl.locator('.ag-drawer');
        await drawer.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);
        await shot('04-alpha-drawer-open');

        const cancelBtn = drawer.getByRole('button', { name: 'Ask to cancel' });
        await cancelBtn.click(); // arm
        await page.waitForTimeout(200);
        const armedText = await cancelBtn.textContent();
        assert(
          /ask to cancel\?/i.test(armedText ?? ''),
          `expected armed label "Ask to cancel?", got ${armedText}`,
        );
        await shot('05-alpha-cancel-armed');

        await cancelBtn.click(); // confirm
        await page.waitForTimeout(1000);
        await shot('06-alpha-cancel-confirmed');

        // The parked branch narrates via a TOAST (not #noticeBanner -- narrate()
        // clears the banner for 'parked' by design, see logic.js), e.g. "Sent
        // to the owner for confirmation -- it stays on the agenda until
        // approved." Assert that toast copy, and that no "cancelled" toast
        // (the pre-fix, executed-immediately copy) ever appeared instead.
        const toastTexts = await fl
          .locator('kit-toast')
          .allTextContents()
          .catch(() => []);
        console.log(`[v01] toasts after cancel-confirm: ${JSON.stringify(toastTexts)}`);
        const parkToast = toastTexts.find((t) => /sent to the owner for confirmation/i.test(t));
        assert(
          parkToast,
          `expected a "sent to the owner for confirmation" toast, got: ${JSON.stringify(toastTexts)}`,
        );
        const executedToast = toastTexts.find((t) => /^event cancelled/i.test(t));
        assert(
          !executedToast,
          `must NOT show an "Event cancelled" toast (would mean it executed immediately), got: ${JSON.stringify(toastTexts)}`,
        );

        // Drawer UI corroborates: "Cancel pending" chip + disabled-looking
        // "Cancellation pending" button + activity log entry, and stays open.
        const pendingChip = await drawer.locator('text=Cancel pending').count();
        assert(pendingChip >= 1, 'expected a "Cancel pending" chip on the drawer header');
        const drawerStillOpen = await drawer.isVisible().catch(() => false);
        assert(drawerStillOpen, 'drawer should stay open (parked state), not close as if executed');

        await fl.locator('[aria-label="Close"]').first().click();
        await page.waitForTimeout(300);
        await fl
          .locator('.kit-seg button', { hasText: 'Month' })
          .click()
          .catch(() => undefined);
        await page.waitForTimeout(400);
        const stillThere = await fl.locator('.ag-pill', { hasText: 'Verify Alpha' }).count();
        assert(
          stillThere >= 1,
          'Verify Alpha event must still be present on the calendar (parked, not executed)',
        );
        await shot('07-alpha-still-on-calendar');
      },
    );

    await step(
      'approvals-lists-cancel',
      'Approvals surface lists the parked cancel_event entry',
      async () => {
        await navTo(page, 'Approvals');
        await page
          .getByRole('heading', { name: 'Approvals', level: 1 })
          .waitFor({ state: 'visible', timeout: 10_000 });
        await page.waitForTimeout(500);
        await shot('08-approvals-before-approve');
        const scheduleRows = await page
          .locator('text=/schedule\\.(cancel_event|cancel-event)/i')
          .count();
        const bodyText = await page.locator('body').innerText();
        const mentionsAlpha = /Verify Alpha/i.test(bodyText);
        console.log(
          `[v01] Approvals schedule.cancel_event rows: ${scheduleRows}, mentions "Verify Alpha": ${mentionsAlpha}`,
        );
        assert(
          scheduleRows > 0 || mentionsAlpha,
          'expected an Approvals entry for the parked cancel_event',
        );
      },
    );

    await step(
      'approve-actually-cancels',
      'Approving the parked entry actually cancels the event in Agenda',
      async () => {
        const row = page.locator('text=schedule.cancel_event').first();
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        await row.click();
        await page.waitForTimeout(500);
        await shot('08b-approvals-detail-view');
        const approveBtn = page.getByRole('button', { name: 'Approve', exact: true }).first();
        await approveBtn.waitFor({ state: 'visible', timeout: 10_000 });
        await approveBtn.click();
        await page.waitForTimeout(1000);
        await shot('09-approvals-after-approve');

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
        await fl
          .locator('.kit-seg button', { hasText: 'Month' })
          .click()
          .catch(() => undefined);
        await page.waitForTimeout(400);
        const goneCount = await fl.locator('.ag-pill', { hasText: 'Verify Alpha' }).count();
        console.log(`[v01] "Verify Alpha" pill count after approval: ${goneCount}`);
        assert(
          goneCount === 0,
          'expected Verify Alpha to be actually cancelled (gone from calendar) after owner approval',
        );
        await shot('10-alpha-gone-after-approval');
      },
    );

    await step(
      'reschedule-parks-not-executes',
      'Move Beta via the drawer -- must PARK (parked toast + activity log, event keeps its original time)',
      async () => {
        const pill = fl.locator('.ag-pill', { hasText: 'Verify Beta' });
        await pill.waitFor({ state: 'visible', timeout: 10_000 });
        await pill.click();
        const drawer = fl.locator('.ag-drawer');
        await drawer.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);
        const startInput = drawer.locator('input[type="datetime-local"]').first();
        const originalStart = await startInput.inputValue();
        const newStart = originalStart.replace(
          /T(\d{2}):/,
          (m, h) => `T${String((Number(h) + 2) % 24).padStart(2, '0')}:`,
        );
        await startInput.fill(newStart);
        await page.waitForTimeout(200);
        await shot('11-beta-drawer-before-move');
        await drawer.getByRole('button', { name: 'Move event' }).click();
        await page.waitForTimeout(1000);
        await shot('12-beta-after-move-click');

        // Design note: the drawer closes on BOTH 'executed' and 'parked'
        // outcomes (EventDrawer.jsx submitReschedule) -- parking is narrated
        // via the toast + activity log, not by keeping the drawer open (that
        // is different from cancel's UI, which uses a "pending" chip inline).
        const toastTexts = await fl
          .locator('kit-toast')
          .allTextContents()
          .catch(() => []);
        console.log(`[v01] toasts after reschedule attempt: ${JSON.stringify(toastTexts)}`);
        const parkToast = toastTexts.find(
          (t) =>
            /sent to the owner for confirmation/i.test(t) && /current time until approved/i.test(t),
        );
        assert(
          parkToast,
          `expected a "sent to the owner for confirmation ... stays at its current time" toast, got: ${JSON.stringify(toastTexts)}`,
        );
        const movedToast = toastTexts.find((t) => /^event moved/i.test(t));
        assert(
          !movedToast,
          `must NOT show "Event moved" toast (would mean it executed immediately), got: ${JSON.stringify(toastTexts)}`,
        );
        await shot('13-beta-parked-toast');

        // Reopen the event and confirm the start time is still the ORIGINAL
        // one -- the reschedule must not have actually moved it.
        await fl.locator('.ag-pill', { hasText: 'Verify Beta' }).click();
        const drawer2 = fl.locator('.ag-drawer');
        await drawer2.waitFor({ state: 'visible', timeout: 5000 });
        await page.waitForTimeout(300);
        const reopenedStart = await drawer2
          .locator('input[type="datetime-local"]')
          .first()
          .inputValue();
        console.log(
          `[v01] Beta start before attempted move: ${originalStart}, after: ${reopenedStart}`,
        );
        assert(
          reopenedStart === originalStart,
          `Beta's start time changed (${originalStart} -> ${reopenedStart}) -- reschedule executed immediately instead of parking`,
        );
        const activityText = await drawer2
          .locator('.ag-activity, [class*="activity"]')
          .innerText()
          .catch(() => '');
        console.log(
          `[v01] activity log mentions parked move: ${/parked for the owner/i.test(activityText)}`,
        );
        await shot('14-beta-reopened-time-unchanged');
      },
    );

    // ---- Report ----
    console.log('\n================ VERIFY-01 VERDICT TABLE ================');
    for (const r of results) {
      console.log(`${r.verdict.toUpperCase().padEnd(6)} ${r.id.padEnd(30)} ${r.label} (${r.ms}ms)`);
      if (r.error) console.log(`       -> ${r.error.split('\n')[0]}`);
    }
    const failCount = results.filter((r) => r.verdict === 'fail').length;
    if (failCount > 0) {
      console.error(`\n${failCount} step(s) FAILED.`);
      process.exitCode = 1;
    } else {
      console.log('\nAll verify-01 steps PASSED.');
    }
  } catch (err) {
    const failShot = path.join(OUT_DIR, 'v01-FAILURE.png');
    await page.screenshot({ path: failShot }).catch(() => undefined);
    console.error(`[v01] FATAL -- screenshot at ${failShot}`);
    throw err;
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
