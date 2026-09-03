import { promises as fs } from "node:fs";
import path from "node:path";

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
  seedRemoteGatewayProfile,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

async function gotoSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: /All apps/iu }).click();
  await page
    .getByRole("dialog", { name: "All apps" })
    .getByRole("button", { name: "Settings", exact: true })
    .click();
}

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway();
  await seedRemoteGateway(env, gateway);
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

test("12.1 — picking a theme in Appearance applies it live and saves to the gateway", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId("settings-page").waitFor({ state: "visible" });

    const appearance = page.getByRole("tablist", { name: "Appearance" });
    await appearance.getByRole("tab", { name: "Light" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");
    await expect
      .poll(() =>
        gateway.calls.some(
          (c) =>
            c.method === "PUT" &&
            c.pathname === "/_centraid-user/prefs" &&
            /"themeMode"\s*:\s*"light"/u.test(c.body ?? "")
        )
      )
      .toBe(true);
  } finally {
    await closeApp(app);
  }
});

test("12.5 — appearance choices persist across a reload", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId("settings-page").waitFor({ state: "visible" });
    const appearance = page.getByRole("tablist", { name: "Appearance" });
    await appearance.getByRole("tab", { name: "Light" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");
    await page.reload();
    await waitForHome(page);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");
  } finally {
    await closeApp(app);
  }
});

test("12.6 — an explicit dark theme survives a full Electron restart", async () => {
  const launched = await launchApp(env);
  try {
    await waitForHome(launched.page);
    await gotoSettings(launched.page);
    await launched.page
      .getByTestId("settings-page")
      .waitFor({ state: "visible" });
    const themes = launched.page.getByRole("tablist", {
      name: "Appearance",
    });
    await themes.getByRole("tab", { name: "Light" }).click();
    await expect
      .poll(() =>
        launched.page.evaluate(() => document.documentElement.dataset.theme)
      )
      .toBe("light");
    await themes.getByRole("tab", { name: "Dark" }).click();
    await expect
      .poll(() =>
        launched.page.evaluate(() => document.documentElement.dataset.theme)
      )
      .toBe("dark");
    await closeApp(launched.app);

    const restarted = await launchApp(env);
    try {
      await waitForHome(restarted.page);
      await expect
        .poll(() =>
          restarted.page.evaluate(() => document.documentElement.dataset.theme)
        )
        .toBe("dark");
    } finally {
      await closeApp(restarted.app);
    }
  } finally {
    await closeApp(launched.app);
  }
});

test('12.2 — "Match system" resolves the OS scheme to a theme and persists it', async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId("settings-page").waitFor({ state: "visible" });

    await page
      .getByRole("tablist", { name: "Appearance" })
      .getByRole("tab", { name: "Match system" })
      .click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toMatch(/^(?:light|dark)$/u);
    await expect
      .poll(() =>
        gateway.calls.some(
          (c) =>
            c.method === "PUT" &&
            c.pathname === "/_centraid-user/prefs" &&
            /"themeMode"\s*:\s*"system"/u.test(c.body ?? "")
        )
      )
      .toBe(true);
  } finally {
    await closeApp(app);
  }
});

test("12.4 — the Agents (providers) settings page renders", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId("settings-page").waitFor({ state: "visible" });

    await page
      .getByTestId("settings-nav")
      .getByRole("button", { name: "Agents" })
      .click();
    await expect(
      page
        .getByTestId("settings-dialog")
        .getByRole("heading", { name: "Agents" })
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Default agent" })
    ).toBeVisible({
      timeout: 10_000,
    });
    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await fs.mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-743-one-agent-door.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
  }
});

test("13.2 — desktop exposes pairing-only gateway enrollment", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    expect(
      await page.evaluate(() => typeof window.CentraidApi.addGateway)
    ).toBe("undefined");
    const gateways = await page.evaluate(() =>
      window.CentraidApi.listGateways()
    );
    expect(gateways.some((entry) => entry.id === env.gatewayId)).toBe(true);
    const rows = JSON.parse(
      await fs.readFile(path.join(env.userData, "connections.json"), "utf8")
    ) as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.id === env.gatewayId)).toMatchObject({
      endpointId: env.gatewayId,
    });
    expect(JSON.stringify(rows)).not.toMatch(/"(?:url|token|transport)"/u);
    await expect(
      fs.access(path.join(env.userData, "gateways"))
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const rendererConnectionState = await page.evaluate(() =>
      Object.keys(localStorage).filter(
        (key) =>
          key.startsWith("centraid.v1.") &&
          /gateway|connection|credential|token/iu.test(key)
      )
    );
    expect(rendererConnectionState).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test("13.4 — switching the active gateway re-scopes home", async () => {
  gateway.state.apps = [appEntry({ id: "shared", name: "Shared App" })];
  const newId = await seedRemoteGatewayProfile(env, gateway, {
    label: "Second",
  });
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const callsBefore = gateway.calls.length;
    await page.evaluate(
      (id) => window.CentraidApi.setActiveGateway({ id }),
      newId
    );

    await expect
      .poll(() =>
        page.evaluate(() =>
          window.CentraidApi.getSettings().then(
            (s) => (s as { activeGatewayId: string }).activeGatewayId
          )
        )
      )
      .toBe(newId);
    await expect.poll(() => gateway.calls.length).toBeGreaterThan(callsBefore);
    await expect(page.locator('nav[aria-label="Apps"]')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("13.7 — a remote gateway can be removed; the local one cannot", async () => {
  const id = await seedRemoteGatewayProfile(env, gateway, { label: "Temp" });
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await page.evaluate(
      (gid) => window.CentraidApi.removeGateway({ id: gid }),
      id
    );
    const list = (await page.evaluate(() =>
      window.CentraidApi.listGateways()
    )) as Array<{
      id: string;
    }>;
    expect(list.some((g) => g.id === id)).toBe(false);

    const localErr = await page.evaluate(() =>
      window.CentraidApi.removeGateway({ id: "local" })
        .then(() => null)
        .catch((error: Error) => String(error.message ?? error))
    );
    expect(localErr).toBeTruthy();
  } finally {
    await closeApp(app);
  }
});

test("13.5 + 13.6 — a paired remote gateway can be renamed without creating address credentials", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    const id = env.gatewayId;

    await page.evaluate(
      (gid) =>
        window.CentraidApi.renameGateway({ id: gid, label: "New Label" }),
      id
    );
    const list = (await page.evaluate(() =>
      window.CentraidApi.listGateways()
    )) as Array<{
      id: string;
      label: string;
    }>;
    expect(list.find((g) => g.id === id)?.label).toBe("New Label");

    const rows = JSON.parse(
      await fs.readFile(path.join(env.userData, "connections.json"), "utf8")
    ) as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.id === id)).toMatchObject({
      id,
      endpointId: id,
      label: "New Label",
    });
    expect(JSON.stringify(rows)).not.toMatch(/"(?:url|token|transport)"/u);
  } finally {
    await closeApp(app);
  }
});

test("13.8 — switching to an unreachable gateway degrades gracefully", async () => {
  const deadId = await seedRemoteGatewayProfile(
    env,
    { url: "http://127.0.0.1:1" },
    { label: "Dead" }
  );
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await page.evaluate(
      (id) => window.CentraidApi.setActiveGateway({ id }),
      deadId
    );
    await expect(page.locator('nav[aria-label="Apps"]')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("14.2 — a first-party inline app has no Build control", async () => {
  gateway.state.apps = [appEntry({ id: "tasks", name: "Tasks" })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await openAppFromPalette(page, "Tasks");
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Build", exact: true })
    ).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});

test("14.4 — Cmd+K opens the command palette", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await page.keyboard.press("Meta+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
