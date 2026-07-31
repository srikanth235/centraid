import { defineConfig } from "vitest/config";

/** Standalone Stryker test root for civil-time recurrence (defineConfig, not defineProject). */
export default defineConfig({
  test: {
    name: "@centraid/time-engine-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/recurrence.test.ts",
      "src/recurrence-properties.test.ts",
      "src/timezone-properties.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
