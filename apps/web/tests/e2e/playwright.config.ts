import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const here = import.meta.dirname;

// W5.1 (#842) — cross-browser matrix. The suite used to declare no `projects`,
// which Playwright treats as a single implicit Chromium project: every PWA and
// offline journey was only ever measured on one engine. Service-worker
// registration, Cache Storage eviction, and IndexedDB durability all diverge in
// WebKit (Safari's SW lifecycle and 7-day storage cap) and, less sharply, in
// Firefox — precisely the surfaces web-pwa / web-pwa-cache / offline-reconnect
// assert. So this file now declares the engines explicitly.
//
// The base container ships Chromium only (`/opt/pw-browsers` has no webkit or
// firefox bundle). Declaring webkit/firefox unconditionally would make the
// default `bun run e2e` and the Chromium-only nightly job fail on a missing
// browser download — a fake red that says nothing about the product. So the
// extra engines are gated behind CENTRAID_WEB_CROSS_BROWSER: the default path
// stays Chromium-only and green, and the cross-browser CI job (e2e.yml
// `web-e2e-cross-browser`, reported to root under #842) sets the flag AFTER
// `bunx playwright install --with-deps chromium webkit firefox`. Until that job
// runs for the first time the webkit/firefox result is UNMEASURED, not green —
// its first CI run is the measurement (#842 W5.1 demonstrated-red).
//
// `--list` enumerates the webkit/firefox specs without launching a browser, so
// the projects are verifiably CONFIGURED here even though they cannot RUN here.
const crossBrowser =
  process.env.CENTRAID_WEB_CROSS_BROWSER === "1" ||
  process.env.CENTRAID_WEB_CROSS_BROWSER === "true";

// Chromium-tuned or engine-pinned specs stay OFF the extra engines:
//   perf-waterfall — every budget in perf-budgets.ts is a Chromium timing
//     number; a WebKit/Firefox timeline is a different measurement, not a
//     regression, so running it cross-engine would only manufacture noise.
//   rebuilt-apps — its own header pins it to Chromium in CI.
// Everything else (PWA boot, SW cache, offline reconnect, docs byte journey,
// nav rail, grants, people, accessibility) is exercised on every engine.
const enginePinnedToChromium = [
  "**/perf-waterfall.spec.ts",
  "**/rebuilt-apps.spec.ts",
];

// Firefox is a deliberately thin SMOKE tier, not a third full matrix: the two
// journeys that would catch a Gecko-only boot or offline-settle break, without
// paying a full-suite third run every night.
const firefoxSmoke = ["**/web-pwa.spec.ts", "**/offline-reconnect.spec.ts"];

export default defineConfig({
  testDir: here,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  // Repo-root artifacts/ (not apps/web/artifacts/) so nightly upload-artifact
  // `path: artifacts/` and generate.mjs readPlaywright agree (#535 F2).
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
  // Suite-level backstop, CI only. Without it nothing stops the run before the
  // job's `timeout-minutes`, and a job-level cancel is unconditional: it kills
  // the reporter mid-flush, so the JSON report and traces are never written and
  // a degraded suite reports NO usable evidence (this is what happened to
  // desktop-e2e in run 29694615676). Sized far above the healthy runtime
  // (~1min of tests) — this is a runaway guard, not a perf budget, and it must
  // fire before the workflow cap so the reporter still gets to flush.
  //
  // Cross-browser triples the runnable spec count (chromium full + webkit full
  // + firefox smoke), so the backstop widens with it — still a runaway guard,
  // sized well above healthy runtime, still below the job cap reported to root.
  globalTimeout: process.env.CI ? (crossBrowser ? 25 : 10) * 60_000 : undefined,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // chromium is always declared and always the default project, so a bare
  // `playwright test` / `bun run e2e` (no `--project`) runs exactly the suite
  // it ran before this change. webkit + firefox are appended only when the
  // cross-browser flag is set (see the header note).
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
