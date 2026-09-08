import { defineConfig } from "vitest/config";

/**
 * Unit tests for pure test-report / mutation helpers + focused agent-e2e
 * harness helpers (not part of package projects). Coverage is seeded on the
 * ratchet-unit lane (#545 D10) so scripts/ helpers cannot silently drop
 * instrumented lines.
 */
export default defineConfig({
  test: {
    name: "test-report-scripts",
    include: [
      "scripts/test-report/**/*.test.mjs",
      "scripts/mutation/**/*.test.mjs",
      "tests/agent-e2e-shared/**/*.test.mjs",
      "tests/agent-e2e-mobile/lib/**/*.test.mjs",
    ],
    environment: "node",
    pool: "forks",
    expect: { requireAssertions: true },
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./artifacts/coverage-scripts",
      include: [
        "scripts/test-report/**/*.{mjs,js,ts}",
        "scripts/mutation/**/*.{mjs,js,ts}",
        "tests/agent-e2e-shared/**/*.{mjs,js}",
      ],
      exclude: ["**/*.test.mjs", "**/*.test.ts", "**/vitest.config.ts"],
      // Conservative seed under realistic unit coverage of pure helpers
      // (~36% lines measured with current unit set); ratchet upward once
      // more script modules gain tests (up-only floors live elsewhere).
      //
      // `functions` was 40 under @vitest/coverage-v8 3.x. Version 4 made
      // AST-aware remapping the only mode, so nested arrows and callbacks now
      // count as functions too — the denominator grew to 218 and the same test
      // set measures 30.27%. This is a re-seed against the new definition, not
      // a regression in what the tests cover; these thresholds are local to
      // this lane and are not the ratcheted floors in tests/floors.json#coverage.
      // #915 re-seeded these upward: the report's reader/renderer split gave
      // the model and every section a unit suite, and the measured numbers
      // moved from ~36% to 66/61/79/66. Seeded a few points under the
      // measurement, as the floors elsewhere are — tighten-only, never lowered
      // to buy room for an untested module.
      thresholds: {
        lines: 62,
        branches: 57,
        functions: 74,
        statements: 62,
      },
    },
  },
});
