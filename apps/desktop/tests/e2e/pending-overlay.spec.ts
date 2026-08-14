import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  cleanupEnv,
  closeApp,
  launchApp,
  makeEnv,
  openAppFromPalette,
  waitForHome,
} from "./fixtures";

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
  // First run is now one connection act: the local path starts the embedded
  // host and hands straight to Home. Profile identity belongs in Settings, so
  // this fixture must not resurrect the deleted name/color gate.
  const onboarding = page.getByTestId("onboarding-view");
  await onboarding.waitFor({ state: "visible", timeout: 60_000 });
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
}

/**
 * Prepare only the canonical rows the two edit journeys need. The writes run
 * through the production inline-app bridge and real local gateway; the
 * offline writes below use the visible product controls.
 */
async function prepareTally(page: Page): Promise<string> {
  await openFirstParty(page, "Tally");
  type Dashboard = { friends: Array<{ party_id: string }> };
  let dashboard: Dashboard | undefined;
  await expect
    .poll(
      async () => {
        try {
          dashboard = await page.evaluate(() =>
            window.centraid.read<Dashboard>({ query: "dashboard", input: {} })
          );
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  const prepared = await page.evaluate(async (existingMemberId) => {
    const client = window.centraid;
    let friendStatus = "already-present";
    let memberId = existingMemberId;
    if (!memberId) {
      const friend = await client.write({
        action: "add-friend",
        input: { name: "Offline Teammate" },
      });
      friendStatus = friend.status;
      memberId = friend.output?.["party_id"] as string | undefined;
    }
    const group = await client.write({
      action: "create-group",
      input: {
        name: "Offline Journey",
        icon: "🏠",
        color: "#6f5bf6",
        member_ids: [memberId!],
      },
    });
    return {
      friendStatus,
      groupStatus: group.status,
      groupId: group.output?.["group_id"],
    };
  }, dashboard!.friends[0]?.party_id);
  expect(["already-present", "executed"]).toContain(prepared.friendStatus);
  expect(prepared.groupStatus).toBe("executed");
  expect(prepared.groupId).toEqual(expect.any(String));
  return String(prepared.groupId);
}

async function prepareAgenda(page: Page): Promise<string> {
  await openFirstParty(page, "Agenda");
  type Upcoming = {
    calendars: Array<{ calendar_id: string }>;
  };
  type Parties = {
    parties: Array<{ party_id: string; is_you?: boolean }>;
  };
  let setup: { upcoming: Upcoming; parties: Parties } | undefined;
  await expect
    .poll(
      async () => {
        try {
          setup = await page.evaluate(async () => {
            const client = window.centraid;
            const [upcoming, parties] = await Promise.all([
              client.read<Upcoming>({
                query: "upcoming",
                input: {
                  from: new Date(Date.now() - 86_400_000).toISOString(),
                },
              }),
              client.read<Parties>({ query: "parties", input: {} }),
            ]);
            return { upcoming, parties };
          });
          return true;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  const prepared = await page.evaluate(async (ready) => {
    const client = window.centraid;
    const start = new Date(Date.now() + 86_400_000);
    const event = await client.write({
      action: "propose",
      input: {
        summary: "Offline RSVP planning",
        calendar_id: ready.upcoming.calendars[0]!.calendar_id,
        dtstart: start.toISOString(),
        dtend: new Date(start.getTime() + 3_600_000).toISOString(),
        start_tz: "UTC",
        attendee_party_ids: [
          ready.parties.parties.find((party) => party.is_you)!.party_id,
        ],
      },
    });
    return { status: event.status, eventId: event.output?.["event_id"] };
  }, setup!);
  expect(prepared.status).toBe("executed");
  expect(prepared.eventId).toEqual(expect.any(String));
  return String(prepared.eventId);
}

test("production Tally, Tasks, and Agenda pending rows survive an offline Electron reload", async () => {
  test.setTimeout(180_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    const groupId = await prepareTally(page);
    const eventId = await prepareAgenda(page);

    // Warm each production inline bundle before the browser context loses its
    // network. The local outbox, query engine, and app routes remain real.
    await openFirstParty(page, "Tasks");
    await openFirstParty(page, "Tally");
    await openFirstParty(page, "Agenda");
    await expect(
      page.getByRole("button", { name: /Offline RSVP planning/u })
    ).toBeVisible({ timeout: 30_000 });
    await page.context().setOffline(true);

    await openFirstParty(page, "Tasks");
    await page
      .getByRole("textbox", { name: "Task title" })
      .fill("Offline task");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Offline task", { exact: true })).toBeVisible();
    await expect(page.locator(".kit-pending-chip")).toHaveText("queued");

    await openFirstParty(page, "Tally");
    await page.getByText("Offline Journey", { exact: true }).first().click();
    await page.getByRole("button", { name: "Add expense" }).click();
    await page.getByPlaceholder("What was it for?").fill("Offline lunch");
    await page.locator('input[inputmode="decimal"]').first().fill("12.50");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText("Offline lunch", { exact: true })
    ).toBeVisible();
    const expenseCancel = page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true });
    if (await expenseCancel.isVisible()) await expenseCancel.click();
    expect(groupId).not.toBe("");

    await openFirstParty(page, "Agenda");
    const plannedEvent = page.getByRole("button", {
      name: /Offline RSVP planning/u,
    });
    await expect(plannedEvent).toBeVisible();
    await plannedEvent.click();
    await page.getByRole("button", { name: "Going" }).click();
    await expect(page.getByRole("dialog")).toHaveClass(/kit-pending/u);
    await expect(
      page.getByRole("dialog").locator(".kit-pending-chip")
    ).toHaveText("queued");
    expect(eventId).not.toBe("");

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Agenda");
    const restoredEvent = page.getByRole("button", {
      name: /Offline RSVP planning/u,
    });
    await expect(restoredEvent).toBeVisible();
    await restoredEvent.click();
    await expect(page.getByRole("dialog")).toHaveClass(/kit-pending/u);
    await expect(
      page.getByRole("dialog").locator(".kit-pending-chip")
    ).toHaveText("queued");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close" })
      .click();

    await openFirstParty(page, "Tasks");
    await expect(page.getByText("Offline task", { exact: true })).toBeVisible();
    await expect(page.locator(".kit-pending-chip")).toHaveText("queued");

    await openFirstParty(page, "Tally");
    await page.getByText("Offline Journey", { exact: true }).first().click();
    await expect(
      page.getByText("Offline lunch", { exact: true })
    ).toBeVisible();
    const tallyPending = page.locator(".kit-pending-chip");
    await expect(tallyPending).toHaveText("pending");
    await expect(tallyPending).toHaveAttribute(
      "title",
      "Waiting for a connection."
    );

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-738-pending-write-overlay.png"),
      fullPage: true,
    });
  } finally {
    await page
      .context()
      .setOffline(false)
      .catch(() => undefined);
    await closeApp(app);
    await cleanupEnv(env);
  }
});
