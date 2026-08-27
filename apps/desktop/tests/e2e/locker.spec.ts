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

// Locker admission journey on the custodian seat (#781, rebuilt for #872):
// first open demands the passphrase setup, an added item persists on the REAL
// local gateway, and an Electron reload lands back on the lock wall — the item
// stays invisible until the same passphrase unlocks it. The viewer-seat refusal
// half lives in apps/web/tests/e2e/locker-seat.spec.ts
// (docs/blueprint-seats.md S5).
//
// THE TWO GATES ARE WALLS, NOT DIALOGS. `components/Lock.tsx` renders a plain
// `<form>` in the route's scroll slot — `shelves.suppressesNavigation` has
// already withdrawn the rail, the band and every list, so there is nothing for
// a modal to sit over and no `role="dialog"` anywhere in this app's gates. The
// pre-#872 spec drove a `.kit-modal` "Protect your Locker" dialog; that surface
// no longer exists, and asserting on it was a green claim about a deleted UI.
//
// EVERY PASSPHRASE FIELD IS `type="password"`, which exposes NO `textbox` role
// — `getByRole("textbox")` cannot see one. The fields are addressed by their
// accessible name instead (`getByLabel`), which is the `aria-label` Lock.tsx
// and Edit.tsx put on each input.

const PASSPHRASE = "orange-battery-staple-42";
const ITEM_TITLE = "Bank vault door";
const ITEM_SECRET = "correct-horse-battery-staple";

/** `view-copy.ts` SETUP_PLACEHOLDER — the setup field's own accessible name. */
const SETUP_FIELD = "At least 12 characters";
/** `view-copy.ts` LOCK_PLACEHOLDER — the locked wall's field. */
const LOCK_FIELD = "Passphrase";
/** `view-copy.ts` LOCK_BODY — what the locked wall says a session is. */
const LOCK_BODY =
  "Five minutes of inactivity, hidden windows and a restart all end a session.";

async function openFirstParty(page: Page, name: string): Promise<void> {
  await openAppFromPalette(page, name);
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await expect(page.getByText(`Loading ${name}…`, { exact: true })).toHaveCount(
    0
  );
}

async function foundDesktop(page: Page): Promise<void> {
  await page
    .getByTestId("first-run-choice")
    .getByRole("button", { name: /start fresh on this mac/iu })
    .click();
  // The fresh/local path now founds Personal and hands off to Home directly;
  // identity is optional Settings state, not a first-run gate.
  const onboarding = page.getByTestId("onboarding-view");
  await onboarding.waitFor({ state: "visible" });
  await expect(page.getByRole("textbox", { name: "Your name" })).toHaveCount(0);
  await onboarding.waitFor({ state: "detached", timeout: 60_000 });
  await waitForHome(page);
}

test("Locker demands setup, keeps an item, and relocks across an Electron reload", async () => {
  test.setTimeout(180_000);
  const env = await makeEnv();
  const { app, page } = await launchApp(env);
  try {
    await foundDesktop(page);
    await openFirstParty(page, "Locker");

    // FIRST OPEN ON A FRESH VAULT: the setup wall, not a browsable list. The
    // rule — twelve characters, and the fact that it cannot be revoked — is
    // stated ABOVE the field rather than discovered by a refusal, so the
    // sentence is part of what this journey checks.
    await expect(
      page.getByText("Choose a passphrase", { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(
        "Twelve characters at least, the only way in that cannot be revoked, and nothing here is browsable until it exists.",
        { exact: true }
      )
    ).toBeVisible();
    await page.getByLabel(SETUP_FIELD, { exact: true }).fill(PASSPHRASE);
    await page.getByRole("button", { name: "Create it", exact: true }).click();

    // DAY ONE, past the gate. An empty Locker is an offer with two ways in;
    // `Add a login` is the one a member with nothing kept can actually see.
    // (The app bar's `New item` is the same act from the frame above.)
    await expect(
      page.getByText("Nothing is kept here yet.", { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole("button", { name: "Add a login", exact: true })
      .click();

    // The add / edit surface is a ROUTE, not a modal: `shelves.EDIT` fills the
    // pane, and the lede says the online-only rule before anything is typed.
    await expect(
      page.getByRole("heading", { name: "New item", exact: true })
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill(ITEM_TITLE);
    // A login's password field is sealed and therefore `type="password"`.
    await page.getByLabel("Password", { exact: true }).fill(ITEM_SECRET);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    // The item lands as a list row. A row is addressed by its stable
    // `data-item-id` anchor (components/Rows.tsx), never by a class name.
    const itemRow = page
      .locator("[data-item-id]")
      .filter({ hasText: ITEM_TITLE });
    await expect(itemRow.first()).toBeVisible({ timeout: 30_000 });

    // Reload the renderer: the memory session is gone, so Locker must land on
    // the LOCKED wall and the item must not be readable behind it. Nothing
    // about the item — not even its title, which is metadata — survives the
    // wipe on screen (`session.wipeSecretState`).
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Locker");
    await expect(page.getByText("Locked", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(LOCK_BODY, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Unlock", exact: true })
    ).toBeVisible();
    await expect(itemRow).toHaveCount(0);
    await expect(page.getByText(ITEM_TITLE, { exact: true })).toHaveCount(0);
    // A passphrase that already exists is never asked for again as a first
    // run: the wall behind a reload is the LOCK, and it says so.
    await expect(
      page.getByText("Choose a passphrase", { exact: true })
    ).toHaveCount(0);

    // The same passphrase unlocks, and the item survived on the gateway — a
    // vault row on the local host, not renderer state.
    await page.getByLabel(LOCK_FIELD, { exact: true }).fill(PASSPHRASE);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(itemRow.first()).toBeVisible({ timeout: 30_000 });

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "desktop-locker-custodian.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
