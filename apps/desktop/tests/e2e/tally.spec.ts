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

const GROUP_NAME = "Hilltop flat";
const FRIEND_NAME = "Priya Raman";
const SEAT_FRIEND_NAME = "Marcus Ilves";

const DAY_ONE = "Nothing is split yet.";
const DAY_ONE_SUB =
  "The first real move is one expense with one person; a group can wait for three of you.";
const DAY_ONE_ACT = "Add an expense";
const FRIEND_BODY =
  "A friend is a person in People — adding one writes there, and every app knows the same person.";

const RAIL_DESTINATIONS = [
  "Balances",
  "Activity",
  "Waiting",
  "Recurring",
  "Spending",
  "Trash",
];

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

test("Tally lands on day one, mints a group and a friend through its own sheets, and both survive an Electron reload", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Tally");

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "delete-expense",
                input: { expense_id: "expense-readiness-probe" },
                intentId: "tally-desktop-e2e-readiness-probe",
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          }),
        { timeout: 60_000 }
      )
      .not.toBe("replica-not-ready");

    await expect(page.getByText(DAY_ONE, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(DAY_ONE_SUB, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: DAY_ONE_ACT, exact: true })
    ).toBeVisible();

    const rail = page.locator('nav[aria-label="Tally"]');
    await expect(rail).toBeVisible();
    await Promise.all(
      RAIL_DESTINATIONS.map((destination) =>
        expect(
          rail.getByRole("button", { name: destination, exact: true })
        ).toBeVisible()
      )
    );

    await page
      .getByRole("group", { name: "Tally view" })
      .getByRole("button", { name: "Groups", exact: true })
      .click();
    await expect(page.getByText("No groups yet.", { exact: true })).toBeVisible(
      { timeout: 30_000 }
    );
    await page.getByRole("button", { name: "New group", exact: true }).click();

    const groupSheet = page
      .getByRole("dialog")
      .filter({ hasText: "New group" });
    await expect(groupSheet).toBeVisible();
    await groupSheet.getByLabel("Name", { exact: true }).fill(GROUP_NAME);
    await groupSheet
      .getByRole("button", { name: "Create", exact: true })
      .click();

    const groupRow = page.locator(`[data-row-title="${GROUP_NAME}"]`);
    await expect(groupRow.first()).toBeVisible({ timeout: 30_000 });

    await rail.getByRole("button", { name: "Balances", exact: true }).click();
    await expect(page.getByText(DAY_ONE, { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("No friends yet.", { exact: true })
    ).toBeVisible({ timeout: 30_000 });

    await page
      .getByRole("button", { name: "Add a friend", exact: true })
      .click();
    const friendSheet = page
      .getByRole("dialog")
      .filter({ hasText: "Add a friend" });
    await expect(friendSheet).toBeVisible();
    await expect(
      friendSheet.getByText(FRIEND_BODY, { exact: true })
    ).toBeVisible();
    await friendSheet.getByLabel("Name", { exact: true }).fill(FRIEND_NAME);
    await friendSheet.getByRole("button", { name: "Add", exact: true }).click();

    const friendRow = page.locator(`[data-row-title="${FRIEND_NAME}"]`);
    await expect(friendRow.first()).toBeVisible({ timeout: 30_000 });

    const custodianOutcome = await page.evaluate(async (name) => {
      const outcome = await window.centraid.write({
        action: "add-friend",
        input: { name },
        intentId: "tally-desktop-e2e-custodian-add-friend",
      });
      return outcome.status;
    }, SEAT_FRIEND_NAME);
    expect(custodianOutcome).toBe("executed");

    const seatRow = page.locator(`[data-row-title="${SEAT_FRIEND_NAME}"]`);
    await expect
      .poll(
        async () => {
          if ((await seatRow.count()) > 0) return true;
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          return (await seatRow.count()) > 0;
        },
        { timeout: 60_000 }
      )
      .toBe(true);

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Tally");
    await expect(friendRow.first()).toBeVisible({ timeout: 60_000 });
    await expect(seatRow.first()).toBeVisible();
    await expect(groupRow.first()).toBeVisible();

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "desktop-tally-custodian.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
