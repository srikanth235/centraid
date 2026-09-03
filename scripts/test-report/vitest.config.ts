import { defineConfig } from "vitest/config";

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
      thresholds: {
        lines: 62,
        branches: 57,
        functions: 74,
        statements: 62,
      },
    },
  },
});
