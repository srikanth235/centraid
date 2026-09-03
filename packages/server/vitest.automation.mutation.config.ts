import { defineConfig } from "vitest/config";

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
