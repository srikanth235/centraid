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

// Tally on the CUSTODIAN seat (rebuilt interface, #872).
//
// THE JOURNEY IS THE ROOM'S OWN FIRST HOUR. A fresh vault lands on day one —
// `Nothing is split yet.` — and day one is a FACT ABOUT A READ THAT LANDED,
// which is why the sample week is cleared through Home's own control first:
// Tally ships a `seed.js`, so an unfilled vault and a sample-filled one are two
// different screens and only one of them is day one.
//
// DAY ONE OFFERS ONE MOVE, AND IT IS NOT `Add a friend`. `components/Route.tsx`
// swaps the whole Balances body for the day-one block while there are no
// friends and no groups, so the People section — and the `Add a friend` verb
// that opens the compose sheet — does not exist yet. The first thing this
// journey mints is therefore a GROUP, through the Groups route's own sheet;
// that write is what brings Balances back and the friend sheet with it. Both
// sheets are real `<dialog>`s opened with `showModal()` (components/Panels.tsx
// `FormSheet`), so they answer `role="dialog"` — and they carry no accessible
// name of their own, which is why each is located by the heading it draws.
//
// Nothing is mocked. `makeEnv`/`launchApp` boot the real Electron app, the
// first-run "start fresh on this mac" path founds a real Personal vault on the
// embedded gateway, and both writes below go through the product's own sheets.
// The two direct `window.centraid` calls are the write-rail readiness probe (a
// write the vault deterministically REFUSES, so readiness costs no row) and the
// seat assertion itself.
//
// Duplicated helpers: `openFirstParty` and `foundDesktop` are copied in-file
// from tasks.spec.ts / notes.spec.ts rather than shared. That is the convention
// in this directory — each journey owns the first-run path it depends on, so a
// change to one journey's onboarding expectations cannot silently retarget the
// others.

const GROUP_NAME = "Hilltop flat";
const FRIEND_NAME = "Priya Raman";
/** Minted through the write door rather than the sheet — the seat assertion. */
const SEAT_FRIEND_NAME = "Marcus Ilves";

/** `view-copy.ts` DAY_ONE / DAY_ONE_SUB / DAY_ONE_ACT, verbatim. */
const DAY_ONE = "Nothing is split yet.";
const DAY_ONE_SUB =
  "The first real move is one expense with one person; a group can wait for three of you.";
const DAY_ONE_ACT = "Add an expense";
/** `compose-copy.ts` FRIEND_BODY — what the friend sheet says a friend IS. */
const FRIEND_BODY =
  "A friend is a person in People — adding one writes there, and every app knows the same person.";

/** The rail's own destinations (components/Rail.tsx → `shelves.shelfLabel`).
 *  The two group-and-people lists under them are empty on a fresh vault. */
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

test("Tally lands on day one, mints a group and a friend through its own sheets, and both survive an Electron reload", async () => {
  test.setTimeout(300_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Tally");

    // The inline replica session bootstraps asynchronously; a write issued
    // before it does throws rather than answering. Prove the rail is up with a
    // probe the vault deterministically REFUSES — `delete-expense` carries an
    // `expense_live` precondition and no expense by this id was ever minted —
    // so readiness costs no row and cannot pollute the ledger.
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

    // DAY ONE ON A FRESH VAULT, in the room's own words: one sentence, one that
    // says why the first move is one expense with one person, and the single
    // act that follows from it.
    await expect(page.getByText(DAY_ONE, { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText(DAY_ONE_SUB, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: DAY_ONE_ACT, exact: true })
    ).toBeVisible();

    // The rail stands beside it with every destination reachable — a day-one
    // canvas withdraws nothing, because there is nothing wrong with the vault.
    const rail = page.locator('nav[aria-label="Tally"]');
    await expect(rail).toBeVisible();
    await Promise.all(
      RAIL_DESTINATIONS.map((destination) =>
        expect(
          rail.getByRole("button", { name: destination, exact: true })
        ).toBeVisible()
      )
    );

    // THE FIRST WRITE, through the product's own sheet. Groups is reached from
    // the app bar's segmented switcher (the band carries the same four
    // destinations on a compact surface); its section is empty on its own
    // terms, and its verb opens the sheet that mints a group.
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

    // A row is addressed by its stable `data-row-title` anchor
    // (components/LedgerRow.tsx), never by a class name.
    const groupRow = page.locator(`[data-row-title="${GROUP_NAME}"]`);
    await expect(groupRow.first()).toBeVisible({ timeout: 30_000 });

    // With a group on the ledger the day-one block is gone and Balances draws
    // itself — the hero, the People section and the verb that opens the friend
    // sheet. Back to it through the rail's own row.
    await rail.getByRole("button", { name: "Balances", exact: true }).click();
    await expect(page.getByText(DAY_ONE, { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("No friends yet.", { exact: true })
    ).toBeVisible({ timeout: 30_000 });

    // THE SECOND WRITE. A friend is a person in People — the sheet says so
    // before the name is typed, which is the whole reason Tally keeps no
    // directory of its own.
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

    // THE SEAT ASSERTION, stated directly. A write through the same door the
    // app's own handlers use must come back `executed` — never `queued`, never
    // `in-flight`. This is the one fact that distinguishes a custodian, which
    // hosts the vault in this process, from a viewer that has to reach one.
    const custodianOutcome = await page.evaluate(async (name) => {
      const outcome = await window.centraid.write({
        action: "add-friend",
        input: { name },
        intentId: "tally-desktop-e2e-custodian-add-friend",
      });
      return outcome.status;
    }, SEAT_FRIEND_NAME);
    expect(custodianOutcome).toBe("executed");

    // And it is a vault row, not a renderer fact: the room re-reads on its own
    // change subscription, and the app's sanctioned focus re-read is the poll's
    // second chance rather than a wait on a clock.
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

    // A group and a person are rows on the LOCAL gateway: both must come back
    // after a full Electron reload, with the ledger reading the same.
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
