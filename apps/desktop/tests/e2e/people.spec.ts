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

const PERSON_NAME = "Ines Vartanian";
const PERSON_ROLE = "luthier";
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
  const onboarding = page.getByTestId("onboarding-view");
  await onboarding.waitFor({ state: "visible", timeout: 60_000 });
  await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
  await clearFirstRunSample(page);
}

test("People mints a person on the custodian seat and it survives an Electron reload", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "People");

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

    await expect(
      page.getByText("Add the people you keep up with", { exact: true })
    ).toBeVisible({ timeout: 60_000 });
    await page
      .getByTestId("inline-app-view")
      .getByRole("button", { name: "Add person", exact: true })
      .click();

    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill(PERSON_NAME);
    await page
      .getByRole("textbox", { name: "Role", exact: true })
      .fill(PERSON_ROLE);
    await page.getByRole("button", { name: CADENCE_CHIP, exact: true }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();

    await expect(statusLine(page)).toContainText(`${PERSON_NAME} added`, {
      timeout: 30_000,
    });

    const rosterRow = page.getByRole("button", { name: `Open ${PERSON_NAME}` });
    await expect(rosterRow.first()).toBeVisible({ timeout: 30_000 });

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

    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "People");
    await expect(rosterRow.first()).toBeVisible({ timeout: 30_000 });

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
