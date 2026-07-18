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
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: '../../artifacts/test-results/desktop-playwright.json' }]]
    : 'list',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
