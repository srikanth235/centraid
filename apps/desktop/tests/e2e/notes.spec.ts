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

const NOTE_TITLE = "Lease terms";
const NOTE_BODY = "The deposit clause moved to §4 and the notice runs 60 days.";

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

test("Notes writes a passage on the custodian seat and its body survives an Electron reload", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Notes");

    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "edit-note",
                input: { note_id: "note-readiness-probe", title: "probe" },
                intentId: "notes-desktop-e2e-readiness-probe",
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
      page.getByText("Write the first one.", { exact: true })
    ).toBeVisible({ timeout: 60_000 });
    await page
      .getByTestId("inline-app-view")
      .getByRole("button", { name: "New note", exact: true })
      .click();

    await page.getByRole("textbox", { name: "Note title" }).fill(NOTE_TITLE);
    await page.getByRole("textbox", { name: "Note body" }).fill(NOTE_BODY);

    const heading = page.getByText(NOTE_TITLE, { exact: true });
    await page.getByRole("button", { name: "Library", exact: true }).click();
    await expect
      .poll(
        async () => {
          if ((await heading.count()) > 0) return true;
          await page.evaluate(() => window.dispatchEvent(new Event("focus")));
          return (await heading.count()) > 0;
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    await expect(heading.first()).toBeVisible();

    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ title }) => {
              type Library = { notes: Array<{ title?: string }> };
              const library = await window.centraid.read<Library>({
                query: "library",
                input: {},
              });
              return (library.notes ?? []).some((row) => row.title === title);
            },
            { title: NOTE_TITLE }
          ),
        { timeout: 60_000 }
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ title }) => {
              type Library = {
                notes: Array<{ note_id: string; title?: string }>;
              };
              const library = await window.centraid.read<Library>({
                query: "library",
                input: {},
              });
              const note = library.notes.find((row) => row.title === title);
              if (!note) return "no-such-note";
              const outcome = await window.centraid.write({
                action: "edit-note",
                input: { note_id: note.note_id, title },
                intentId: `notes-desktop-e2e-custodian-edit-${Date.now()}`,
              });
              return outcome.status;
            },
            { title: NOTE_TITLE }
          ),
        { timeout: 60_000 }
      )
      .toBe("executed");

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Notes");
    await expect(heading.first()).toBeVisible({ timeout: 30_000 });

    const body = page.getByRole("textbox", { name: "Note body" });
    await expect
      .poll(
        async () => {
          if ((await body.count()) > 0) return true;
          if ((await heading.count()) > 0) await heading.first().click();
          return (await body.count()) > 0;
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    await expect(body.first()).toHaveValue(NOTE_BODY);
    await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(
      NOTE_TITLE
    );

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "desktop-notes-custodian.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
