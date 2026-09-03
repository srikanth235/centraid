import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/core/time-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/time/recurrence.test.ts",
      "src/time/rrule-support.test.ts",
      "src/time/recurrence-properties.test.ts",
      "src/time/recurrence-lifecycle-properties.test.ts",
      "src/time/timezone-properties.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
