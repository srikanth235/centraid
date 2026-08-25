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
  statusLine,
  waitForHome,
} from "./fixtures";

// People on the CUSTODIAN seat (matrix cell `people.custodian`, #864).
//
// THE MIRROR IS THE POINT. `apps/web/tests/e2e/people.spec.ts` runs the same
// journey on the VIEWER seat — mint a person, reload the shell, open the person
// screen — and the contrast between the two files is what the seat pair is for.
// The viewer holds no vault: its writes travel the control transport to a
// gateway somewhere else, and the honest outcome of a write it cannot reach is
// `queued`. The custodian IS the vault's host: the embedded local gateway is in
// this process, so the same write must come back `executed`, every time, with
// no queue in between. A custodian that ever answered `queued` on a healthy
// local write would be a device telling its owner it cannot reach itself.
//
// Nothing is mocked. `makeEnv`/`launchApp` boot the real Electron app, the
// first-run "start fresh on this mac" path founds a real Personal vault on the
// embedded gateway, and every write below goes through the product's own
// controls. The two direct `window.centraid` calls are the write-rail readiness
// probe (a write the vault deterministically REFUSES, so readiness costs no
// row) and the seat assertion itself.
//
// Duplicated helpers: `openFirstParty` and `foundDesktop` are copied in-file
// from docs-drive.spec.ts / pending-overlay.spec.ts rather than shared. That is
// the convention in this directory — each journey owns the first-run path it
// depends on, so a change to one journey's onboarding expectations cannot
// silently retarget the others.

const PERSON_NAME = "Ines Vartanian";
const PERSON_ROLE = "luthier";
// Deliberately NOT the form's default (`view-state.ts` DEFAULT_CADENCE = 30):
// a chip that matched the default would be a control whose press proves
// nothing. The person screen's cadence line below reads back this number.
const CADENCE_CHIP = "14 days";

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
}

test("People mints a person on the custodian seat and it survives an Electron reload", async () => {
  test.setTimeout(180_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "People");

    // The inline replica session bootstraps asynchronously; a write issued
    // before it does throws rather than answering. Prove the rail is up with a
    // probe the vault deterministically REFUSES — `people.set_cadence` has a
    // `person_exists` precondition, and no party by this id was ever minted —
    // so readiness costs no row and cannot pollute the roster this journey is
    // about.
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            try {
              const outcome = await window.centraid.write({
                action: "set-cadence",
                input: { party_id: "party-readiness-probe", cadence_days: 7 },
                intentId: "people-desktop-e2e-readiness-probe",
              });
              return outcome.status;
            } catch {
              return "replica-not-ready";
            }
          }),
        { timeout: 60_000 }
      )
      .not.toBe("replica-not-ready");

    // DAY ONE ON A FRESH VAULT. Past the loading gate an empty roster is a
    // fact, and the first run is the one screen in this app with a display head
    // and a commit of its own. It is also the only way into the new-person form
    // that a member with nobody yet can see, which is why the journey starts
    // here rather than at the app bar's `Add`.
    await expect(
      page.getByText("Add the people you keep up with", { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Add person", exact: true }).click();

    // The form, filled through its own fields and chips — no synthetic write.
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill(PERSON_NAME);
    await page
      .getByRole("textbox", { name: "Role", exact: true })
      .fill(PERSON_ROLE);
    await page.getByRole("button", { name: CADENCE_CHIP, exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // THE CUSTODIAN'S OWN SENTENCE. `settle()` gives the frame's one status
    // line the outcome text only on `executed`; a queued write would put
    // "Queued on this device." here instead, and a park would say it was
    // waiting for approval. The line is the product-visible half of this
    // cell's claim.
    await expect(statusLine(page)).toContainText(`${PERSON_NAME} added`, {
      timeout: 30_000,
    });

    // …and the row, whose accessible name is the shared Row recipe's.
    const rosterRow = page.getByRole("button", { name: `Open ${PERSON_NAME}` });
    await expect(rosterRow.first()).toBeVisible({ timeout: 30_000 });

    // THE SEAT ASSERTION, stated directly. A second write through the same door
    // the app's own handlers use must come back `executed` — never `queued`,
    // never `in-flight`. This is the one fact that distinguishes this file from
    // its viewer-seat mirror.
    const custodianOutcome = await page.evaluate(
      async ({ name }) => {
        type Roster = { people: Array<{ party_id: string; name: string }> };
        const drive: Roster = await window.centraid.read<Roster>({
          query: "people",
          input: {},
        });
        const person = drive.people.find(
          (row: { name: string }) => row.name === name
        );
        if (!person) return "no-such-person";
        const outcome = await window.centraid.write({
          action: "star-person",
          input: { party_id: person.party_id },
          intentId: "people-desktop-e2e-custodian-star",
        });
        return outcome.status;
      },
      { name: PERSON_NAME }
    );
    expect(custodianOutcome).toBe("executed");

    // A person is a vault row on the local gateway, not renderer state: she
    // must come back after a full Electron reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "People");
    await expect(rosterRow.first()).toBeVisible({ timeout: 30_000 });

    // Opening the row lands on the person screen: the hero name, the cadence
    // line in the handoff's own words, and the Log commit. Re-click until the
    // screen answers — right after a reload the row can paint before its React
    // listener attaches, and a click in that window is silently lost.
    const personScreen = page.locator('section[aria-label="Person"]');
    await expect
      .poll(
        async () => {
          if (await personScreen.isVisible()) return true;
          if ((await rosterRow.count()) > 0) await rosterRow.first().click();
          return personScreen.isVisible();
        },
        { timeout: 60_000 }
      )
      .toBe(true);
    await expect(personScreen.getByText(PERSON_NAME).first()).toBeVisible();
    await expect(page.getByText(/^Every 14 days · last /u)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Log", exact: true })
    ).toBeVisible();

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "desktop-people-custodian.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
