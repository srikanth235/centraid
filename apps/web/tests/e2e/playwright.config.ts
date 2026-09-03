import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const here = import.meta.dirname;

const crossBrowser =
  process.env.CENTRAID_WEB_CROSS_BROWSER === "1" ||
  process.env.CENTRAID_WEB_CROSS_BROWSER === "true";

const enginePinnedToChromium = [
  "**/perf-waterfall.spec.ts",
  "**/rebuilt-apps.spec.ts",
];

const firefoxSmoke = ["**/web-pwa.spec.ts", "**/offline-reconnect.spec.ts"];

export default defineConfig({
  testDir: here,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
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
  globalTimeout: process.env.CI ? (crossBrowser ? 25 : 10) * 60_000 : undefined,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
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
