import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints/triage-mutation",
    environment: "node",
    pool: "forks",
    include: ["apps/_shared/triage-session.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
