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
  statusLine,
  waitForHome,
} from "./fixtures";

const TASK_TITLE = "Renew the passport";

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

async function showLogbook(page: Page): Promise<void> {
  const logbook = page.getByRole("button", { name: /^Logbook/u });
  await expect
    .poll(
      async () => {
        if ((await logbook.count()) === 0) return false;
        await logbook.first().click();
        return true;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
}

test("Tasks files and completes a task on the custodian seat, and the Logbook survives an Electron reload", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Tasks");

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "set-status",
                input: {
                  task_id: "task-readiness-probe",
                  status: "completed",
                },
                intentId: "tasks-desktop-e2e-readiness-probe",
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          }),
        { timeout: 60_000 }
      )
      .not.toBe("replica-not-ready");

    await expect(
      page.getByText("Add the first thing you must not forget.", {
        exact: true,
      })
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add a task", exact: true }).click();

    const capture = page.getByRole("dialog", { name: "Add" });
    await capture.getByRole("textbox", { name: "Add" }).fill(TASK_TITLE);
    await capture.getByRole("button", { name: "Add", exact: true }).click();

    const taskRow = page
      .locator("[data-task-id]")
      .filter({ hasText: TASK_TITLE });
    await expect(taskRow.first()).toBeVisible({ timeout: 30_000 });

    const box = taskRow.locator("button[aria-pressed]").first();
    await expect(box).toHaveAttribute("aria-pressed", "false");
    await box.click();
    await expect(statusLine(page)).toContainText("Done", { timeout: 30_000 });

    await expect(taskRow).toHaveCount(0, { timeout: 30_000 });
    await showLogbook(page);
    await expect(taskRow.first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: TASK_TITLE, exact: true }).first()
    ).toHaveAttribute("aria-pressed", "true");

    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ title }) => {
              type Board = {
                open: Array<{ task_id: string; title: string }>;
                logbook: Array<{ task_id: string; title: string }>;
              };
              const board = await window.centraid.read<Board>({
                query: "board",
                input: {},
              });
              const task = [...board.open, ...board.logbook].find(
                (row) => row.title === title
              );
              if (!task) return "no-such-task";
              const outcome = await window.centraid.write({
                action: "edit",
                input: { task_id: task.task_id, title },
                intentId: `tasks-desktop-e2e-custodian-edit-${Date.now()}`,
              });
              return outcome.status;
            },
            { title: TASK_TITLE }
          ),
        { timeout: 60_000 }
      )
      .toBe("executed");

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Tasks");
    await expect(taskRow).toHaveCount(0, { timeout: 30_000 });
    await showLogbook(page);
    await expect(taskRow.first()).toBeVisible({ timeout: 30_000 });

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "desktop-tasks-custodian.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
