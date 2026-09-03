import { promises as fs } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";
import type * as TypeImport_11i4z7t from "@playwright/test";

import {
  appEntry,
  closeApp,
  cleanupEnv,
  gotoNav,
  launchApp,
  makeEnv,
  markUserApp,
  openTile,
  seedRemoteGateway,
  startMockGateway,
  waitForHome,
} from "./fixtures";
import type { MockGateway, TestEnv } from "./fixtures";

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway({ appsDir: env.appsDir });
  await seedRemoteGateway(env, gateway);
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

async function openApp(
  page: TypeImport_11i4z7t.Page,
  id: string,
  name: string
): Promise<void> {
  await waitForHome(page);
  await markUserApp(page, { id, name });
  await page.reload();
  await waitForHome(page);
  await openTile(page, id);
  await page.getByTestId("inline-app-view").waitFor({ state: "visible" });
}

test("7.1 — opening a system app renders inline; back returns home", async () => {
  gateway.state.apps = [appEntry({ id: "notes", name: "Notes" })];
  const { app, page } = await launchApp(env);
  try {
    await openApp(page, "notes", "Notes");
    await expect(page.getByTestId("inline-app-view")).toBeVisible();
    await expect(page.locator("iframe[data-centraid-app]")).toHaveCount(0);
    await page.keyboard.press("Meta+[");
    await waitForHome(page);
    await expect(
      page.locator(
        '[data-testid="home-springboard"], [data-testid="home-first-run"]'
      )
    ).toBeVisible();
  } finally {
    await closeApp(app);
  }
});

test("10.2 — an automation template clone survives a fresh gateway instance and Electron process", async () => {
  gateway.state.templates = [
    {
      id: "obligation-extractor",
      name: "Daily Digest",
      desc: "Summarize the day",
      colorKey: "violet",
      iconKey: "Todo",
      version: "1",
      kind: "automation",
      triggerKind: "cron",
      triggerLabel: "Every day",
    },
  ];
  gateway.state.cloneResult = {
    app: {
      id: "digest-clone",
      name: "Daily Digest",
      description: "Summarize the day",
      kind: "automation",
    },
    template: gateway.state.templates[0],
    webhooks: [],
  };
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined =
    await launchApp(env);
  try {
    await waitForHome(launched.page);
    await gotoNav(launched.page, "Automations");
    await launched.page
      .getByRole("button", { name: "Browse templates" })
      .click();
    await launched.page.getByRole("button", { name: /Daily Digest/u }).click();
    await launched.page
      .getByRole("dialog", { name: "Daily Digest template" })
      .getByRole("button", { name: /Use template/u })
      .click();
    await expect
      .poll(
        () =>
          gateway.calls.some(
            (c) =>
              c.method === "POST" && c.pathname === "/centraid/_apps/_clone"
          ),
        { timeout: 10_000 }
      )
      .toBe(true);
    await expect.poll(() => gateway.state.automations).toHaveLength(1);

    await gotoNav(launched.page, "Automations");
    await launched.page
      .getByRole("button", { name: "Templates" })
      .first()
      .click();
    await expect(
      launched.page.getByRole("button", { name: /Daily Digest/u })
    ).toBeVisible();

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await fs.mkdir(evidenceDir, { recursive: true });
    await launched.page.screenshot({
      path: path.join(evidenceDir, "issue-765-v9-binding-layer.png"),
      fullPage: true,
    });

    const manifestPath = path.join(env.appsDir, "digest-clone", "app.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      id: string;
      name: string;
    };
    expect(manifest).toMatchObject({
      id: "digest-clone",
      name: "Daily Digest",
    });

    await closeApp(launched.app);
    launched = undefined;
    await gateway.close();
    gateway = await startMockGateway({ appsDir: env.appsDir });
    await seedRemoteGateway(env, gateway);

    launched = await launchApp(env);
    await waitForHome(launched.page);
    await gotoNav(launched.page, "Automations");
    await expect(launched.page.getByTitle("Open Daily Digest")).toBeVisible();
    await expect(fs.access(manifestPath)).resolves.toBeUndefined();
  } finally {
    if (launched) await closeApp(launched.app);
  }
});

test("11.1 — Analytics renders the runs chart and what it cost", async () => {
  gateway.state.insights = {
    windowDays: 30,
    generatedAt: Date.now(),
    kpis: {
      totalTokens: 12345,
      unpricedRuns: 0,
      unreportedRuns: 0,
      totalCostUsd: 1.23,
      harnessReportedCostUsd: 1,
      estimatedCostUsd: 0.23,
      forecastCostUsd: 4.56,
      appsTouched: 3,
      generations: 7,
      retries: 1,
      failedRuns: 0,
      failedCostUsd: 0,
    },
    daily: [
      { date: "2024-05-01", tokens: 5000, costUsd: 0.5, runs: 2 },
      { date: "2024-05-02", tokens: 7345, costUsd: 0.73, runs: 5 },
    ],
    bySource: [
      {
        key: "app/digest",
        label: "Digest",
        kind: "automation",
        runs: 3,
        tokens: 8000,
        costUsd: 0.8,
      },
    ],
    byHarness: [
      { harness: "claude-code", runs: 7, tokens: 12345, costUsd: 1.23 },
    ],
    byModel: [{ model: "tier-deep", runs: 7, tokens: 12345, costUsd: 1.23 }],
    byEffort: [{ effort: "high", runs: 7, tokens: 12345, costUsd: 1.23 }],
    recent: [],
  };
  const { app, page } = await launchApp(env);
  try {
    await waitForHome(page);
    await gotoNav(page, "Analytics");
    await expect(
      page.getByRole("img", { name: "Spend per day over the last 30 days" })
    ).toBeVisible();
    await expect(
      page.getByRole("group", { name: "Time window" })
    ).toBeVisible();
    await expect(
      page.locator("dl[aria-label='Spend by harness']")
    ).toBeVisible();
    await expect(page.locator("body")).toContainText("claude-code");
    await expect(page.locator("body")).toContainText("$1.23");

    const evidenceDir = path.resolve(
      import.meta.dirname,
      "../../../../artifacts/e2e/ui-impact"
    );
    await fs.mkdir(evidenceDir, { recursive: true });
    await page.screenshot({
      path: path.join(evidenceDir, "issue-775-analytics-restored.png"),
      fullPage: true,
    });
  } finally {
    await closeApp(app);
  }
});
