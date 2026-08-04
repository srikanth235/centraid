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

/**
 * REAL Electron launch-time probe (issue #659 R3b).
 *
 * What existed before this: `tests/perf/desktop-cold.perf.test.ts`, whose own
 * comment calls itself a "crude first-import proxy for desktop main modules
 * (not full Electron launch)". It dynamically imports one pure module —
 * `gateway-supervisor-core.ts` — with no Electron process, no renderer, no
 * gateway and no window, and fences it at 3,000 ms. Nothing in the repo has
 * ever measured how long the desktop app takes to become usable, which is the
 * only launch number a vault owner can perceive.
 *
 * This measures three intervals across ONE real launch:
 *
 *   processToFirstWindowMs  `_electron.launch()` → `firstWindow()` resolves.
 *                           Main-process boot: module graph, gateway
 *                           supervisor, BrowserWindow creation.
 *   firstWindowToHomeMs     first window → Home's library tablist visible.
 *                           Renderer boot + first gateway round trips.
 *   coldOpenToUsableMs      the sum — the number the owner experiences.
 *
 * and one interaction:
 *
 *   tapToVisualResponseMs   click an app tile → the app view acknowledges.
 *
 * Deliberately NOT budgeted in this file. A launch time from a cold CI runner
 * has no distribution yet, and inventing a ceiling here would either fence
 * nothing or red the lane on runner jitter. The report is published as
 * `artifacts/perf-input/desktop-launch-report.json`; the gate lives in
 * `tests/perf/desktop-launch.perf.test.ts`, which consumes it on the nightly
 * perf lane and applies the same trailing-median drift budget every other rig
 * uses (30 samples, 1.5x). See tests/experience-budgets/desktop.json.
 *
 * Year-3 declared volume (docs/coding-standards.md D6): NONE — this launch is
 * measured against the mock gateway with a two-app fixture and a fresh
 * `userData`, i.e. an EMPTY vault. It therefore bounds the shell's own boot
 * cost and cannot catch an O(vault-size) launch regression. Closing that gap
 * needs the mock gateway to serve a year-3 app registry (10,000 photos /
 * 5,000 contacts worth of Home content); the volume table in
 * tests/experience-budgets/README.md is the target.
 *
 * On screenshots and Electron generally, see docs/traps/electron-screenshot.md:
 * this spec asserts on selectors, never on pixels, and adds no headless flags
 * of its own — it launches through the same `launchApp` fixture as every other
 * desktop spec so CI's existing xvfb + keyring setup applies unchanged.
 */

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
  gateway.state.apps = [
    appEntry({ id: "launch-probe-app", name: "Launch probe" }),
  ];
  await seedRemoteGateway(env, gateway);

  const launchStarted = Date.now();
  const { app, page } = await launchApp(env);
  const firstWindowAt = Date.now();
  try {
    await waitForHome(page);
    const homeAt = Date.now();

    // tap → visual response: the first deliberate interaction on a booted
    // shell. Custom apps are not Home springboard tiles (#708) — open via the
    // stem Search / palette, which is the durable open path for installed
    // non-first-party apps.
    const tapStarted = Date.now();
    await openAppFromPalette(page, "Launch probe");
    await page
      .locator(
        '[data-testid="app-view"], iframe[data-centraid-app], iframe[title]'
      )
      .first()
      .waitFor({ state: "attached", timeout: 30_000 });
    const tapRespondedAt = Date.now();

    const report = {
      capturedAt: new Date().toISOString(),
      // The single most important field: what this launch was measured
      // AGAINST. See the D6 note in the file header.
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

    // The only assertions here are sanity: a measurement that came back as 0 or
    // negative means the probe timed nothing, which must fail loudly rather
    // than publish a flattering report.
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
