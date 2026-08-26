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

// Tasks on the CUSTODIAN seat (matrix cell `tasks.custodian`, #864).
//
// THE MIRROR IS THE POINT. `apps/web/tests/e2e/tasks.spec.ts` runs the sibling
// journey on the VIEWER seat — mint a task, watch it file itself into the right
// group, reload the shell — and the contrast between the two files is what the
// seat pair is for. The viewer holds no vault: its writes travel the control
// transport to a gateway somewhere else, and the honest outcome of a write it
// cannot reach is `queued`. The custodian IS the vault's host: the embedded
// local gateway runs in this process, so the same write must come back
// `executed`, every time, with no queue in between. A custodian that ever
// answered `queued` on a healthy local write would be a device telling its
// owner it cannot reach itself.
//
// CHECKING OFF IS THE SECOND WRITE, and the one that moves the row between two
// places: a completed task leaves the board and appears in the Logbook. That
// move is derived from the row's status at render time, so a task that came
// back on the board after a reload would be a local vault that kept the row and
// lost what happened to it.
//
// Nothing is mocked. `makeEnv`/`launchApp` boot the real Electron app, the
// first-run "start fresh on this mac" path founds a real Personal vault on the
// embedded gateway, and the task below is filed and completed through the
// product's own controls. The two direct `window.centraid` calls are the
// write-rail readiness probe (a write the vault deterministically REFUSES, so
// readiness costs no row) and the seat assertion itself.
//
// Duplicated helpers: `openFirstParty` and `foundDesktop` are copied in-file
// from docs-drive.spec.ts / pending-overlay.spec.ts rather than shared. That is
// the convention in this directory — each journey owns the first-run path it
// depends on, so a change to one journey's onboarding expectations cannot
// silently retarget the others.

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

/** The Logbook place, from the rail on a pointer window or the More sheet's
 *  list on a compact one — the same label names the row either way. */
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

    // The inline replica session bootstraps asynchronously; a write issued
    // before it does throws rather than answering. Prove the rail is up with a
    // probe the vault deterministically REFUSES — `set-status` has a
    // task-exists precondition and no task by this id was ever minted — so
    // readiness costs no row and cannot pollute the board this journey is
    // about.
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

    // DAY ONE ON A FRESH VAULT. Past the loading gate an empty board is a fact,
    // and its two acts are the way into capture a member with nothing filed can
    // actually see.
    await expect(
      page.getByText("Add the first thing you must not forget.", {
        exact: true,
      })
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add a task", exact: true }).click();

    // Capture, through its own field. Filed from Today, the panel dates the
    // task today — so the row lands on the board rather than in Anytime.
    const capture = page.getByRole("dialog", { name: "Add" });
    await capture.getByRole("textbox", { name: "Add" }).fill(TASK_TITLE);
    await capture.getByRole("button", { name: "Add", exact: true }).click();

    // The task lands as a board row. A row is addressed by its stable
    // `data-task-id`, which is what the row IS — never by a class name, which
    // is presentation.
    const taskRow = page
      .locator("[data-task-id]")
      .filter({ hasText: TASK_TITLE });
    await expect(taskRow.first()).toBeVisible({ timeout: 30_000 });

    // Check it off through the row's own box. The box's accessible name is the
    // task's title, and its pressed state is the task's status — so this is one
    // control saying one thing, not a checkbox beside a label.
    const box = taskRow.locator("button[aria-pressed]").first();
    await expect(box).toHaveAttribute("aria-pressed", "false");
    await box.click();

    // A completed task leaves the board and appears in the Logbook, pressed.
    await expect(taskRow).toHaveCount(0, { timeout: 30_000 });
    await showLogbook(page);
    await expect(taskRow.first()).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole("button", { name: TASK_TITLE, exact: true }).first()
    ).toHaveAttribute("aria-pressed", "true");

    // THE SEAT ASSERTION, stated directly. A second write through the same door
    // the app's own handlers use must come back `executed` — never `queued`,
    // never `in-flight`. This is the one fact that distinguishes this file from
    // its viewer-seat mirror.
    const custodianOutcome = await page.evaluate(
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
          intentId: "tasks-desktop-e2e-custodian-edit",
        });
        return outcome.status;
      },
      { title: TASK_TITLE }
    );
    expect(custodianOutcome).toBe("executed");

    // A task and what happened to it are vault rows on the LOCAL gateway, not
    // renderer state: the completed row must come back in the Logbook — and
    // stay off the board — after a full Electron reload.
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
