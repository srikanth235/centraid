import { defineConfig } from "vitest/config";

/** Standalone Stryker test root for the courier's fail-closed guards. */
export default defineConfig({
  test: {
    name: "@centraid/oauth-worker-mutation",
    environment: "node",
    pool: "forks",
    include: ["src/index.test.ts", "src/worker-guards.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
