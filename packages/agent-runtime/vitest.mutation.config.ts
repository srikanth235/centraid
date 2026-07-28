import { defineConfig } from "vitest/config";

/** Standalone Stryker test root for agent-runtime low-priority helper. */
export default defineConfig({
  test: {
    name: "@centraid/agent-runtime-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/low-priority.test.ts",
      "src/low-priority-properties.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
