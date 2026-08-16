import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  appEntry,
  cleanupEnv,
  closeApp,
  launchApp,
  makeEnv,
  openAppFromPalette,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

/**
 * §3 — App settings on a bundled inline app (#799).
 *
 * The served-app plane is gone: custom draft/code-store apps no longer mount
 * an app view, so Delete-via-settings cannot be reached for them. Bundled
 * first-party apps still expose App settings, but have no danger zone (#708
 * — they reinstall at every vault mount). These cases drive that live
 * surface: open Tasks, open settings, prove Manage has no Delete, prove
 * dismiss paths fire no DELETE.
 */

const TASKS = "Tasks";

async function openSettings(page: Page) {
  await waitForHome(page);
  await openAppFromPalette(page, TASKS);
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
  await page.getByRole("button", { name: "App settings" }).click();
  const settings = page.getByRole("dialog", { name: "App settings" });
  await settings.waitFor({ state: "visible" });
  return settings;
}

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway();
  gateway.state.apps = [appEntry({ id: "tasks", name: TASKS })];
  await seedRemoteGateway(env, gateway);
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

const deletes = (g: MockGateway) =>
  g.calls.filter(
    (c) => c.method === "DELETE" && c.pathname.startsWith("/centraid/_apps/")
  );

test("3.1 — opening Tasks from the palette lands in the inline app view", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await openAppFromPalette(page, TASKS);
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("3.2 — App settings opens from the inline app chrome", async () => {
  const { app, page } = await launchApp(env);
  try {
    const settings = await openSettings(page);
    await expect(settings).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.3 — Manage offers Delete app on the mock-gateway Tasks install", async () => {
  const { app, page } = await launchApp(env);
  try {
    const settings = await openSettings(page);
    await settings.getByRole("button", { name: "Manage", exact: true }).click();
    // Same harness fact as onboarding 2.5: without the template catalog,
    // Tasks is not marked bundled, so the danger zone is the live UI.
    await expect(
      settings.getByRole("button", { name: /Delete app/iu })
    ).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.4 — Close dismisses settings and keeps the app mounted", async () => {
  const { app, page } = await launchApp(env);
  try {
    const settings = await openSettings(page);
    await settings.getByRole("button", { name: "Close" }).click();
    await expect(
      page.getByRole("dialog", { name: "App settings" })
    ).toHaveCount(0);
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.5a — Escape dismisses settings without firing DELETE", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openSettings(page);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("dialog", { name: "App settings" })
    ).toHaveCount(0);
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.5b — Cancel on Delete app keeps the app mounted and fires no DELETE", async () => {
  const { app, page } = await launchApp(env);
  try {
    const settings = await openSettings(page);
    await settings.getByRole("button", { name: "Manage", exact: true }).click();
    const deleteBtn = settings.getByRole("button", { name: /Delete app/iu });
    await deleteBtn.click();
    await deleteBtn.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.5c — backdrop click dismisses settings without firing DELETE", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openSettings(page);
    await page
      .getByRole("presentation")
      .first()
      .click({
        position: { x: 5, y: 5 },
      });
    await expect(
      page.getByRole("dialog", { name: "App settings" })
    ).toHaveCount(0);
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.5d — Home unmounts the inline app after settings is open", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openSettings(page);
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.getByTestId("inline-app-view")).toHaveCount(0);
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});
