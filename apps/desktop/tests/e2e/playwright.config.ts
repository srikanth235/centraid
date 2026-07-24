import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Playwright config for the Centraid desktop E2E suite.
 *
 * Prereq: `npm run build` in apps/desktop (so `dist/main.js` exists).
 * Run with:   pnpm playwright test -c apps/desktop/tests/e2e/playwright.config.ts
 *
 * Tests launch a real Electron process via `_electron.launch()`, each with its
 * own --user-data-dir and a per-test mock gateway. State never leaks between
 * tests.
 */
export default defineConfig({
  testDir: __dirname,
  fullyParallel: false, // Each test owns an Electron process; serial is friendlier.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Repo-root artifacts/ (not apps/desktop/artifacts/) so nightly upload-artifact
  // `path: artifacts/` and generate.mjs readPlaywright agree (#535 F2).
  reporter: process.env.CI
    ? [
        ['list'],
        [
          'json',
          {
            outputFile: path.resolve(
              __dirname,
              '../../../../artifacts/test-results/desktop-playwright.json',
            ),
          },
        ],
      ]
    : 'list',
  timeout: 60_000,
  // Suite-level backstop, CI only. The job's `timeout-minutes` is NOT a
  // substitute: a job-level cancel is unconditional and kills the reporter
  // mid-flush, so a degraded suite uploads no JSON report and no traces —
  // exactly what happened in run 29694615676, where the job died at test 47
  // of 59 and the artifact step logged "No files were found". This fires
  // first, so the run self-aborts while the reporter can still write.
  //
  // Sized from an observed healthy run (9.3m locally, workers:1, Electron).
  // ~2.4x that, to absorb a slower CI runner without false-cancelling a
  // healthy suite; the workflow cap sits above it (see e2e.yml).
  globalTimeout: process.env.CI ? 22 * 60_000 : undefined,
  expect: { timeout: 5_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
