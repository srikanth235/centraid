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
 * §3 — App settings on a bundled inline app (#799, #819).
 *
 * The served-app plane is gone, and v11 also unmounted the frame settings
 * gear: every bundled app draws its bar to a design handoff, and none of
 * those handoffs has a frame control. What the gear opened has no other
 * door. These eight cases pin that live surface: Tasks still mounts, the
 * gear and its dialog stay gone, and opening / leaving the app fires no
 * DELETE.
 */

const TASKS = "Tasks";

async function openTasks(page: Page) {
  await waitForHome(page);
  await openAppFromPalette(page, TASKS);
  await expect(page.getByTestId("inline-app-view")).toBeVisible();
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
    await openTasks(page);
  } finally {
    await closeApp(app);
  }
});

test("3.2 — App settings is not in the inline app chrome", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openTasks(page);
    await expect(
      page.getByRole("button", { name: "App settings" })
    ).toHaveCount(0);
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.3 — Manage and Delete app have no door on the live Tasks install", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openTasks(page);
    await expect(
      page.getByRole("button", { name: "Manage", exact: true })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Delete app/iu })
    ).toHaveCount(0);
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.4 — the App settings dialog is not mounted", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openTasks(page);
    await expect(
      page.getByRole("dialog", { name: "App settings" })
    ).toHaveCount(0);
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.5a — Escape on the mounted app fires no DELETE", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openTasks(page);
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

test("3.5b — opening Tasks never queues a DELETE", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openTasks(page);
    expect(deletes(gateway).length).toBe(0);
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("3.5c — leaving the app via the palette still fires no DELETE", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openTasks(page);
    await openAppFromPalette(page, TASKS);
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});

test("3.5d — Home unmounts the inline app and fires no DELETE", async () => {
  const { app, page } = await launchApp(env);
  try {
    await openTasks(page);
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.getByTestId("inline-app-view")).toHaveCount(0);
    expect(deletes(gateway).length).toBe(0);
  } finally {
    await closeApp(app);
  }
});
