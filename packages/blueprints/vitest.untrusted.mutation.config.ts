import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints/untrusted-mutation",
    environment: "node",
    pool: "forks",
    include: ["apps/_shared/untrusted-properties.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
