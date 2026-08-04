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
  markUserApp,
  openAppFromPalette,
  seedRemoteGateway,
  seedRemoteGatewayProfile,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

/** §12 Settings, §13 Gateways / profiles, §14 cross-cutting. */

/**
 * Open Settings from the All apps sheet (stem foot).
 *
 * Settings is a launcher destination (#707), not a sidebar page. The account
 * menu still hosts it too, but the account control is only mounted once the
 * member identity resolves — All apps is always present on the stem foot.
 */
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

// ─────────────────────────── §12 Settings ───────────────────────────

test("12.1 — picking a theme in Appearance applies it live and saves to the gateway", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoSettings(page);
    await page.getByTestId("settings-page").waitFor({ state: "visible" });

    // Accent swatches were removed in the #608 consolidation. Theme is a
    // three-position Segmented control (role=tablist "Appearance") with
    // Light / Dark / Match system — default is dark (appearance.ts).
    const appearance = page.getByRole("tablist", { name: "Appearance" });
    await appearance.getByRole("tab", { name: "Light" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toBe("light");
    // The change is persisted to the gateway prefs store.
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
    // Cards is a standing control on the same page. `elevated` is never the
    // default (`outlined`), so a reload that restores it proves the prefs
    // write path rather than the shipped default. This used to drive the
    // Density control, which #672 removed along with the density system.
    const cards = page.getByRole("tablist", { name: "Cards" });
    await cards.getByRole("tab", { name: "elevated" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.cards))
      .toBe("elevated");
    await page.reload();
    await waitForHome(page);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.cards))
      .toBe("elevated");
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
    // Theme is the "Appearance" Segmented tablist (SettingsAppearanceScreen);
    // `dark` is also the shipped default (appearance.ts), so pass through
    // Light first — otherwise "survives a restart" would be satisfied by the
    // default alone.
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

    // Match system is a standing position on the Appearance Segmented control,
    // not a one-shot button (#608).
    await page
      .getByRole("tablist", { name: "Appearance" })
      .getByRole("tab", { name: "Match system" })
      .click();
    // A concrete theme is applied to the document root…
    await expect
      .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
      .toMatch(/^(?:light|dark)$/u);
    // …and the choice is mirrored to the gateway prefs store with the mode.
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
    // Scoped to the settings surface: it is an overlay now (#634), so the
    // page underneath keeps its own <h1> mounted behind the dialog.
    await expect(
      page.getByTestId("settings-dialog").getByRole("heading", { level: 1 })
    ).toHaveText("Agents");
    // Realigned: the exclusive "active agent" switch no longer exists. Per
    // SettingsProvidersScreen.tsx:103-113 the exclusive radio was retired by
    // per-subsystem runners and became the *default* lane of the Routing
    // table — so the page's primary control is now the "Default agent" select
    // (SettingsProvidersScreen.tsx:268).
    await expect(
      page.getByRole("combobox", { name: "Default agent" })
    ).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await closeApp(app);
  }
});

// ─────────────────────────── §13 Gateways / profiles ───────────────────────────

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
  // A second gateway pointing at the same mock, so its app list resolves.
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

    // Active pointer flipped and the renderer re-fetched against the gateway.
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
    await waitForHome(page);
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

    // Removing the primordial local gateway is rejected.
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
    // No crash — the shell stays mounted even though the gateway is unreachable.
    // The stem (`nav[aria-label="Apps"]`) is the chrome root post-#707.
    await expect(page.locator('nav[aria-label="Apps"]')).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

// ─────────────────────────── §14 cross-cutting ───────────────────────────

test("14.2 — an auth failure on publish surfaces a token/Settings prompt", async () => {
  const id = "todoer";
  gateway.state.apps = [appEntry({ id, name: "Todoer" })];
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await markUserApp(page, { id, name: "Todoer" });
    await page.reload();
    await waitForHome(page);
    // Custom apps open via palette; Build is the titlebar entry to the builder.
    await openAppFromPalette(page, "Todoer");
    await page.getByRole("button", { name: "Build", exact: true }).click();
    await page.getByTestId("builder-body").waitFor({ state: "visible" });

    gateway.state.forceStatus = 401; // every call now rejects with auth_required
    await page.getByTestId("builder-publish").click();
    await expect(page.getByTestId("builder-body")).toContainText(
      /token|Settings/iu,
      {
        timeout: 15_000,
      }
    );
  } finally {
    await closeApp(app);
  }
});

test("14.4 — Cmd+K opens the command palette", async () => {
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await page.keyboard.press("Meta+k");
    // The palette is a labelled dialog (PaletteScreen.tsx:140).
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
  } finally {
    await closeApp(app);
  }
});
