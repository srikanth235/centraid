import path from "node:path";

import { defineConfig } from "@playwright/test";

/*
 * The desktop seat's Playwright project (#1020 wave 3 lane F).
 *
 * `workers: 1` and `fullyParallel: false`: every test spawns a real sidecar
 * against a real socket path and a real vault file, and two of those at once
 * would race the path. v0's config makes the same choice for the same reason.
 *
 * `globalTimeout` in CI is a backstop, carried from v0 with its note: a job
 * cancel kills the reporter mid-flush, so the suite gives itself a deadline
 * inside the job's.
 */
export default defineConfig({
  testDir: import.meta.dirname,
  // `*.e2e.ts` and not `*.spec.ts`, deliberately. `oxlint.config.ts` — which is
  // law and not this lane's file — puts every test-or-spec TS file under the
  // vitest plugin, and its two Playwright exemptions are keyed on the v0 paths
  // (`apps/desktop/tests/e2e`, `apps/web/tests/e2e`). Renaming the suffix keeps
  // these files out of that glob entirely, which is better than asking for a
  // third exemption: the lint config stays untouched and the file name says
  // which runner owns it.
  testMatch: ["**/*.e2e.ts"],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI
    ? [
        ["list"],
        [
          "json",
          {
            outputFile: path.resolve(
              import.meta.dirname,
              "../../artifacts/test-results/desktop-seat-playwright.json"
            ),
          },
        ],
      ]
    : "list",
  timeout: 120_000,
  globalTimeout: process.env.CI ? 12 * 60_000 : undefined,
  expect: { timeout: 15_000 },
  use: { trace: "retain-on-failure" },
});
