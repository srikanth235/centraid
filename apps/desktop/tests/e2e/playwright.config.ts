import path from "node:path";

import { defineConfig } from "@playwright/test";

const __dirname = import.meta.dirname;

export default defineConfig({
  testDir: __dirname,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Repo root per #535.
  reporter: process.env.CI
    ? [
        ["list"],
        [
          "json",
          {
            outputFile: path.resolve(
              __dirname,
              "../../../../artifacts/test-results/desktop-playwright.json"
            ),
          },
        ],
      ]
    : "list",
  timeout: 60_000,
  // Backstop: job cancel kills the reporter mid-flush (run 29694615676).
  globalTimeout: process.env.CI ? 22 * 60_000 : undefined,
  expect: { timeout: 5_000 },
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
