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

// Notes on the CUSTODIAN seat (matrix cell `notes.custodian`, #864).
//
// THE MIRROR IS THE POINT. `apps/web/tests/e2e/notes.spec.ts` runs the same
// journey on the VIEWER seat — write a passage, reload the shell, open it and
// find the body intact — and the contrast between the two files is what the
// seat pair is for. The viewer holds no vault: its writes travel the control
// transport to a gateway somewhere else, and the honest outcome of a write it
// cannot reach is `queued`. The custodian IS the vault's host: the embedded
// local gateway runs in this process, so the same write must come back
// `executed`, every time, with no queue in between. A custodian that ever
// answered `queued` on a healthy local write would be a device telling its
// owner it cannot reach itself.
//
// The BODY is the half of the claim a row check alone would miss: a library row
// ships a flattened preview and never a body, so the body comes back only if
// the editor's own second read reaches the local vault after the reload.
//
// Nothing is mocked. `makeEnv`/`launchApp` boot the real Electron app, the
// first-run "start fresh on this mac" path founds a real Personal vault on the
// embedded gateway, and the passage below is typed into the product's own
// editor. The two direct `window.centraid` calls are the write-rail readiness
// probe (a write the vault deterministically REFUSES, so readiness costs no
// row) and the seat assertion itself.
//
// Duplicated helpers: `openFirstParty` and `foundDesktop` are copied in-file
// from docs-drive.spec.ts / pending-overlay.spec.ts rather than shared. That is
// the convention in this directory — each journey owns the first-run path it
// depends on, so a change to one journey's onboarding expectations cannot
// silently retarget the others.

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

test("Notes writes a passage on the custodian seat and its body survives an Electron reload", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Notes");

    // The inline replica session bootstraps asynchronously; a write issued
    // before it does throws rather than answering. Prove the rail is up with a
    // probe the vault deterministically REFUSES — `edit-note` has a
    // note-exists precondition and no note by this id was ever minted — so
    // readiness costs no row and cannot pollute the library this journey is
    // about.
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

    // DAY ONE ON A FRESH VAULT. Past the loading gate an empty library is a
    // fact, and its filled act is the way into the editor a member with nothing
    // written can actually see.
    await expect(
      page.getByText("Write the first one.", { exact: true })
    ).toBeVisible({ timeout: 60_000 });
    await page
      .getByTestId("inline-app-view")
      .getByRole("button", { name: "New note", exact: true })
      .click();

    // The editor is the whole composer: a title at the display rung and the
    // body under it, both saved as they are typed. No dialog, no template.
    await page.getByRole("textbox", { name: "Note title" }).fill(NOTE_TITLE);
    await page.getByRole("textbox", { name: "Note body" }).fill(NOTE_BODY);

    // Back to the library, where the passage is a row carrying the heading the
    // member typed. The save is debounced, so the row is polled with the app's
    // own sanctioned re-read rather than waited on by a clock.
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

    // THE SEAT ASSERTION, stated directly. A second write through the same door
    // the app's own handlers use must come back `executed` — never `queued`,
    // never `in-flight`. This is the one fact that distinguishes this file from
    // its viewer-seat mirror.
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

    // A passage is a vault row on the LOCAL gateway, not renderer state: both
    // the row and its body must come back after a full Electron reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Notes");
    await expect(heading.first()).toBeVisible({ timeout: 30_000 });

    // Opening the row lands in the editor with the BODY — a second read the
    // library row never carried. Re-click until the editor answers: right after
    // a reload the row can paint before its React listener attaches, and a
    // click in that window is silently lost.
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
