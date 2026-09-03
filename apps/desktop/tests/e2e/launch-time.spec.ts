import { promises as fs } from "node:fs";
import path from "node:path";

import { test, expect } from "@playwright/test";

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

const REPORT_PATH = path.resolve(
  import.meta.dirname,
  "../../../..",
  "artifacts/perf-input/desktop-launch-report.json"
);

let env: TestEnv;
let gateway: MockGateway;

test.beforeEach(async () => {
  env = await makeEnv();
  gateway = await startMockGateway();
});

test.afterEach(async () => {
  await gateway.close().catch(() => undefined);
  await cleanupEnv(env);
});

test("desktop cold launch — process start to a usable Home", async () => {
  gateway.state.apps = [appEntry({ id: "tasks", name: "Tasks" })];
  await seedRemoteGateway(env, gateway);

  const launchStarted = Date.now();
  const { app, page } = await launchApp(env);
  const firstWindowAt = Date.now();
  try {
    await waitForHome(page);
    const homeAt = Date.now();

    const tapStarted = Date.now();
    await openAppFromPalette(page, "Tasks");
    await page
      .getByTestId("inline-app-view")
      .waitFor({ state: "visible", timeout: 30_000 });
    const tapRespondedAt = Date.now();

    const report = {
      capturedAt: new Date().toISOString(),
      volume: "empty (mock gateway, 1 app, fresh userData)",
      measurements: {
        processToFirstWindowMs: firstWindowAt - launchStarted,
        firstWindowToHomeMs: homeAt - firstWindowAt,
        coldOpenToUsableMs: homeAt - launchStarted,
        tapToVisualResponseMs: tapRespondedAt - tapStarted,
      },
    };
    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fs.writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);

    console.log("\n============ DESKTOP LAUNCH ============");
    console.log(
      `process → first window: ${report.measurements.processToFirstWindowMs} ms`
    );
    console.log(
      `first window → Home:    ${report.measurements.firstWindowToHomeMs} ms`
    );
    console.log(
      `COLD OPEN → USABLE:     ${report.measurements.coldOpenToUsableMs} ms`
    );
    console.log(
      `tap → visual response:  ${report.measurements.tapToVisualResponseMs} ms`
    );
    console.log("========================================\n");

    expect(
      report.measurements.processToFirstWindowMs,
      "process → first window"
    ).toBeGreaterThan(0);
    expect(
      report.measurements.coldOpenToUsableMs,
      "cold open → usable"
    ).toBeGreaterThan(report.measurements.processToFirstWindowMs - 1);
    expect(
      report.measurements.tapToVisualResponseMs,
      "tap → visual response"
    ).toBeGreaterThanOrEqual(0);
  } finally {
    await closeApp(app);
  }
});
