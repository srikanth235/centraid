import path from "node:path";

import { defineConfig } from "@playwright/test";

/*
 * The Companion's Playwright project (#1020 wave 4 lane extension).
 *
 * `workers: 1` and `fullyParallel: false`: every test launches a persistent
 * Chromium profile and writes a native-messaging host manifest into it, and two
 * of those at once would race the profile directory.
 *
 * `*.e2e.ts` and not `*.spec.ts`, for lane F's reason: `oxlint.config.ts` is law
 * and puts every test-or-spec TS file under the vitest plugin, with its two
 * Playwright exemptions keyed on v0's paths. The suffix keeps these files out of
 * that glob entirely, which is better than asking for a third exemption.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: ["**/*.e2e.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env["CI"],
  retries: 0,
  workers: 1,
  reporter: process.env["CI"]
    ? [
        ["list"],
        [
          "json",
          {
            outputFile: path.resolve(
              import.meta.dirname,
              "../../artifacts/test-results/extension-playwright.json"
            ),
          },
        ],
      ]
    : "list",
  timeout: 120_000,
  globalTimeout: process.env["CI"] ? 12 * 60_000 : undefined,
  expect: { timeout: 15_000 },
  use: { trace: "retain-on-failure" },
});
