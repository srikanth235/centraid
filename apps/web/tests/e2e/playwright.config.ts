import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: here,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Repo-root artifacts/ (not apps/web/artifacts/) so nightly upload-artifact
  // `path: artifacts/` and generate.mjs readPlaywright agree (#535 F2).
  reporter: process.env.CI
    ? [
        ['list'],
        [
          'json',
          {
            outputFile: path.resolve(
              here,
              '../../../../artifacts/test-results/web-playwright.json',
            ),
          },
        ],
      ]
    : 'list',
  timeout: 60_000,
  // Suite-level backstop, CI only. Without it nothing stops the run before the
  // job's `timeout-minutes`, and a job-level cancel is unconditional: it kills
  // the reporter mid-flush, so the JSON report and traces are never written and
  // a degraded suite reports NO usable evidence (this is what happened to
  // desktop-e2e in run 29694615676). Sized far above the healthy runtime
  // (~1min of tests) — this is a runaway guard, not a perf budget, and it must
  // fire before the workflow cap so the reporter still gets to flush.
  globalTimeout: process.env.CI ? 10 * 60_000 : undefined,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node --experimental-strip-types tests/e2e/server.ts',
    cwd: path.resolve(here, '../..'),
    url: 'http://127.0.0.1:4173/web-config.json',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
