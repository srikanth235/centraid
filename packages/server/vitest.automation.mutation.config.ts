import { defineConfig } from "vitest/config";

/** Standalone Stryker root — defineConfig, not defineProject. */
export default defineConfig({
  test: {
    name: "@centraid/server/automation-mutation",
    environment: "node",
    pool: "forks",
    include: ["src/automation/fire/scheduler-ledger.contract.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
