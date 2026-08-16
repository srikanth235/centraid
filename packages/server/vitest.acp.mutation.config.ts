import { defineConfig } from "vitest/config";

/** Standalone Stryker test root for agent-runtime low-priority helper. */
export default defineConfig({
  test: {
    name: "@centraid/server/acp-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/acp/low-priority.test.ts",
      "src/acp/low-priority-properties.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
