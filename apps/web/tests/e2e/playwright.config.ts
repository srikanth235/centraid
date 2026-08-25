import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const here = import.meta.dirname;

// Cross-browser matrix (#842): service-worker registration, Cache Storage
// eviction and IndexedDB durability diverge on WebKit and Firefox — exactly
// what web-pwa / web-pwa-cache / offline-reconnect assert.
//
// Never declare webkit/firefox unconditionally: the base container ships
// Chromium only, so `bun run e2e` would fail on a missing browser download.
// They are gated behind CENTRAID_WEB_CROSS_BROWSER, set by the
// `web-e2e-cross-browser` job (e2e.yml) after installing all three.
const crossBrowser =
  process.env.CENTRAID_WEB_CROSS_BROWSER === "1" ||
  process.env.CENTRAID_WEB_CROSS_BROWSER === "true";

// Stay OFF the extra engines: perf-waterfall's budgets (perf-budgets.ts) are
// Chromium timing numbers, so another timeline is noise, not a regression;
// rebuilt-apps pins itself to Chromium in CI.
const enginePinnedToChromium = [
  "**/perf-waterfall.spec.ts",
  "**/rebuilt-apps.spec.ts",
];

// Firefox is a deliberately thin SMOKE tier, not a third full matrix.
const firefoxSmoke = ["**/web-pwa.spec.ts", "**/offline-reconnect.spec.ts"];

export default defineConfig({
  testDir: here,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Repo-root artifacts/ so nightly upload-artifact `path: artifacts/` and
  // generate.mjs readPlaywright agree (#535).
  reporter: process.env.CI
    ? [
        ["list"],
        [
          "json",
          {
            outputFile: path.resolve(
              here,
              "../../../../artifacts/test-results/web-playwright.json"
            ),
          },
        ],
      ]
    : "list",
  timeout: 60_000,
  // CI-only runaway guard, not a perf budget: it must fire BEFORE the job's
  // `timeout-minutes`, whose cancel kills the reporter mid-flush and leaves no
  // JSON report or traces. Widens with cross-browser's tripled spec count.
  globalTimeout: process.env.CI ? (crossBrowser ? 25 : 10) * 60_000 : undefined,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // chromium stays first and unconditional, so a bare `bun run e2e` keeps its
  // Chromium-only meaning; webkit + firefox append only under the flag.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    ...(crossBrowser
      ? [
          {
            name: "webkit",
            testIgnore: enginePinnedToChromium,
            use: { ...devices["Desktop Safari"] },
          },
          {
            name: "firefox",
            testMatch: firefoxSmoke,
            use: { ...devices["Desktop Firefox"] },
          },
        ]
      : []),
  ],
  webServer: {
    command: "node --experimental-strip-types tests/e2e/server.ts",
    cwd: path.resolve(here, "../.."),
    url: "http://127.0.0.1:4173/web-config.json",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
