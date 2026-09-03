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

const PASSPHRASE = "orange-battery-staple-42";
const ITEM_TITLE = "Bank vault door";
const ITEM_SECRET = "correct-horse-battery-staple";

const SETUP_FIELD = "At least 12 characters";
const LOCK_FIELD = "Passphrase";
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

    await expect(
      page.getByText("Nothing is kept here yet.", { exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await page
      .getByRole("button", { name: "Add a login", exact: true })
      .click();

    await expect(
      page.getByRole("heading", { name: "New item", exact: true })
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Title", exact: true })
      .fill(ITEM_TITLE);
    await page.getByLabel("Password", { exact: true }).fill(ITEM_SECRET);
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const itemRow = page
      .locator("[data-item-id]")
      .filter({ hasText: ITEM_TITLE });
    await expect(itemRow.first()).toBeVisible({ timeout: 30_000 });

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
    await expect(
      page.getByText("Choose a passphrase", { exact: true })
    ).toHaveCount(0);

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
