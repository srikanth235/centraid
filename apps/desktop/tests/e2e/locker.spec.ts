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

// Locker admission journey on the custodian seat (#781): first open demands
// the passphrase setup, an added item persists on the REAL local gateway,
// and an Electron reload lands back on the lock screen — the item stays
// invisible until the same passphrase unlocks it. The viewer-seat refusal
// half lives in apps/web/tests/e2e/locker-seat.spec.ts
// (docs/blueprint-seats.md S5).

const PASSPHRASE = "orange-battery-staple-42";
const ITEM_TITLE = "Bank vault door";

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

    // First open on a fresh vault: the setup wall, not a browsable list.
    const lockScreen = page.getByRole("dialog", {
      name: "Protect your Locker",
    });
    await lockScreen.waitFor({ state: "visible", timeout: 30_000 });
    await lockScreen
      .getByRole("textbox", { name: "Passphrase", exact: true })
      .fill(PASSPHRASE);
    await lockScreen
      .getByRole("textbox", { name: "Confirm passphrase", exact: true })
      .fill(PASSPHRASE);
    await lockScreen
      .getByRole("button", { name: "Create passphrase", exact: true })
      .click();
    await expect(page.getByRole("button", { name: /New item/u })).toBeVisible({
      timeout: 30_000,
    });

    // Add an item through the product's own modal. Secret writes are
    // online-only by doctrine; the embedded local gateway is live.
    await page.getByRole("button", { name: /New item/u }).click();
    const modal = page.locator(".kit-modal");
    await modal.getByPlaceholder("Item name").fill(ITEM_TITLE);
    await modal.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByText(ITEM_TITLE, { exact: true }).first()
    ).toBeVisible({ timeout: 30_000 });

    // Reload the renderer: the memory session is gone, so Locker must land
    // on the LOCKED wall and the item must not be readable behind it.
    await page.reload({ waitUntil: "domcontentloaded" });
    await openFirstParty(page, "Locker");
    const relock = page.getByRole("dialog", { name: "Locker is locked" });
    await relock.waitFor({ state: "visible", timeout: 30_000 });
    await expect(page.getByText(ITEM_TITLE, { exact: true })).toHaveCount(0);

    // The same passphrase unlocks, and the item survived on the gateway.
    await relock
      .getByRole("textbox", { name: "Passphrase", exact: true })
      .fill(PASSPHRASE);
    await relock.getByRole("button", { name: "Unlock", exact: true }).click();
    await expect(
      page.getByText(ITEM_TITLE, { exact: true }).first()
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    await closeApp(app);
    await cleanupEnv(env);
  }
});
