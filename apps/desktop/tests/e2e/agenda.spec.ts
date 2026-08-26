import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupEnv,
  clearFirstRunSample,
  closeApp,
  launchApp,
  makeEnv,
  openAppFromPalette,
  waitForHome,
} from "./fixtures";

// Agenda on the CUSTODIAN seat (matrix cell `agenda.custodian`, #864).
//
// THE MIRROR IS THE POINT. `apps/web/tests/e2e/agenda.spec.ts` runs the same
// journey on the VIEWER seat — mint an event, reload the shell, open the
// event's own panel — and the contrast between the two files is what the seat
// pair is for. The viewer holds no vault: its writes travel the control
// transport to a gateway somewhere else, and the honest outcome of a write it
// cannot reach is `queued`. The custodian IS the vault's host: the embedded
// local gateway runs in this process, so the same write must come back
// `executed`, every time, with no queue in between. A custodian that ever
// answered `queued` on a healthy local write would be a device telling its
// owner it cannot reach itself.
//
// Nothing is mocked. `makeEnv`/`launchApp` boot the real Electron app, the
// first-run "start fresh on this mac" path founds a real Personal vault on the
// embedded gateway, and the event below is composed through the product's own
// editor. The two direct `window.centraid` calls are the write-rail readiness
// probe (a write the vault deterministically REFUSES, so readiness costs no
// row) and the seat assertion itself.
//
// Duplicated helpers: `openFirstParty` and `foundDesktop` are copied in-file
// from docs-drive.spec.ts / pending-overlay.spec.ts rather than shared. That is
// the convention in this directory — each journey owns the first-run path it
// depends on, so a change to one journey's onboarding expectations cannot
// silently retarget the others.

const EVENT_TITLE = "Roof survey";

/** Today, so the event is inside every view's window — the month grid, the day
 *  column and the forward-unbounded schedule alike. */
const pad = (value: number): string => String(value).padStart(2, "0");
const TODAY = new Date();
const DAY_STAMP = `${TODAY.getFullYear()}-${pad(TODAY.getMonth() + 1)}-${pad(
  TODAY.getDate()
)}`;
const STARTS_AT = `${DAY_STAMP}T10:00`;
const ENDS_AT = `${DAY_STAMP}T11:00`;

async function openFirstParty(page: Page, name: string): Promise<void> {
  await openAppFromPalette(page, name);
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(page.getByText(`Loading ${name}…`, { exact: true })).toHaveCount(
    0
  );
  await expect
    .poll(() => page.evaluate(() => Boolean(window.centraid)))
    .toBe(true);
}

async function foundDesktop(page: Page): Promise<void> {
  await page
    .getByTestId("first-run-choice")
    .getByRole("button", { name: /start fresh on this mac/iu })
    .click();
  // First run is one connection act: the local path starts the embedded host
  // and hands straight to Home. Profile identity belongs in Settings, so this
  // fixture must not resurrect the deleted name/color gate.
  const onboarding = page.getByTestId("onboarding-view");
  await onboarding.waitFor({ state: "visible", timeout: 60_000 });
  await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
  // Auto-seed is the first-run product path; day-one empty copy is only true
  // after the sample is cleared through the control Home already shows.
  await clearFirstRunSample(page);
}

/** Schedule is the view whose window is unbounded forward, so it is the one
 *  that can be asserted on without pinning the journey to a calendar month.
 *  The same label names the pointer switcher's segment and the compact band's
 *  destination, so one control serves whichever chrome this window drew. */
async function showSchedule(page: Page): Promise<void> {
  const schedule = page.getByRole("button", { name: "Schedule", exact: true });
  await expect
    .poll(
      async () => {
        if ((await schedule.count()) === 0) return false;
        await schedule.first().click();
        return true;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

test("Agenda composes an event on the custodian seat and it survives an Electron reload", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Agenda");

    // The inline replica session bootstraps asynchronously; a write issued
    // before it does throws rather than answering. Prove the rail is up with a
    // probe the vault deterministically REFUSES — `schedule.rsvp` has an
    // event-exists precondition and no event by this id was ever minted — so
    // readiness costs no row and cannot pollute the calendar this journey is
    // about.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "rsvp",
                input: {
                  event_id: "event-readiness-probe",
                  party_id: "party-readiness-probe",
                  partstat: "accepted",
                },
                intentId: "agenda-desktop-e2e-readiness-probe",
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          }),
        { timeout: 60_000 }
      )
      .not.toBe("replica-not-ready");

    // DAY ONE ON A FRESH VAULT. Past the loading gate an empty calendar is a
    // fact, and its one act is the way into the composer a member with nothing
    // on their calendar can actually see.
    await expect(page.getByText("No events yet.", { exact: true })).toBeVisible(
      { timeout: 60_000 }
    );
    await page
      .getByRole("button", { name: "Add the first one", exact: true })
      .click();

    // The composer, filled through its own fields — no synthetic write. The
    // calendar select needs no touch: the vault founds exactly one "Personal"
    // calendar and the editor defaults to it.
    await page.getByLabel("Title", { exact: true }).fill(EVENT_TITLE);
    await page.getByLabel("Starts", { exact: true }).fill(STARTS_AT);
    await page.getByLabel("Ends", { exact: true }).fill(ENDS_AT);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // The event lands as a schedule row through the app's own refresh. A row is
    // addressed by its stable `data-event-id`, which is what the row IS — never
    // by a class name, which is presentation.
    await showSchedule(page);
    const eventRow = page
      .locator("[data-event-id]")
      .filter({ hasText: EVENT_TITLE });
    await expect(eventRow.first()).toBeVisible({ timeout: 30_000 });

    // An event is a vault row on the LOCAL gateway, not renderer state: it must
    // come back after a full Electron reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Agenda");
    await showSchedule(page);
    await expect(eventRow.first()).toBeVisible({ timeout: 30_000 });

    // THE SEAT ASSERTION, stated directly. A second write through the same door
    // the app's own handlers use must come back `executed` — never `queued`,
    // never `in-flight`. This is the one fact that distinguishes this file from
    // its viewer-seat mirror.
    const custodianOutcome = await page.evaluate(
      async ({ title }) => {
        type Upcoming = {
          events: Array<{
            event_id: string;
            summary: string;
            calendar_id?: string | null;
            dtstart: string;
            dtend?: string | null;
          }>;
        };
        const upcoming = await window.centraid.read<Upcoming>({
          query: "upcoming",
          input: {},
        });
        const event = upcoming.events.find((row) => row.summary === title);
        if (!event) return "no-such-event";
        // `edit-event` maps to `schedule.edit_event` (`confirm: true`), which
        // parks for every non-owner-device caller. The app's own Save uses
        // `propose` — the same door, and the one that must come back executed
        // on this seat.
        const start = Date.parse(event.dtstart);
        const later = Number.isFinite(start)
          ? start + 2 * 60 * 60 * 1000
          : Date.now();
        const outcome = await window.centraid.write({
          action: "propose",
          input: {
            summary: `${title} check`,
            dtstart: new Date(later).toISOString(),
            dtend: new Date(later + 60 * 60 * 1000).toISOString(),
            calendar_id: event.calendar_id,
          },
          intentId: "agenda-desktop-e2e-custodian-propose",
        });
        return outcome.status;
      },
      { title: EVENT_TITLE }
    );
    expect(custodianOutcome).toBe("executed");

    // Opening the row lands on the event's own panel, with the cancellation ask
    // the vault parks for the owner rather than a destructive verb that fires.
    // Re-click until the panel answers — right after a reload the row can paint
    // before its React listener attaches, and a click in that window is lost.
    const detail = page.locator(`aside[aria-label="${EVENT_TITLE}"]`);
    await expect
      .poll(
        async () => {
          if (await detail.isVisible()) return true;
          if ((await eventRow.count()) > 0) await eventRow.first().click();
          return detail.isVisible();
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    await expect(
      detail.getByRole("button", { name: "Ask to cancel", exact: true })
    ).toBeVisible();

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "desktop-agenda-custodian.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
