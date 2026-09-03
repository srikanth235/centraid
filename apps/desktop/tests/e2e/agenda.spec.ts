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

const EVENT_TITLE = "Roof survey";

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
  const onboarding = page.getByTestId("onboarding-view");
  await onboarding.waitFor({ state: "visible", timeout: 60_000 });
  await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
  await clearFirstRunSample(page);
}

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

    await expect(page.getByText("No events yet.", { exact: true })).toBeVisible(
      { timeout: 60_000 }
    );
    await page
      .getByRole("button", { name: "Add the first one", exact: true })
      .click();

    await page.getByLabel("Title", { exact: true }).fill(EVENT_TITLE);
    await page.getByLabel("Starts", { exact: true }).fill(STARTS_AT);
    await page.getByLabel("Ends", { exact: true }).fill(ENDS_AT);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await showSchedule(page);
    const eventRow = page
      .locator("[data-event-id]")
      .filter({ hasText: EVENT_TITLE });
    await expect(eventRow.first()).toBeVisible({ timeout: 30_000 });

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Agenda");
    await showSchedule(page);
    await expect(eventRow.first()).toBeVisible({ timeout: 30_000 });

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
