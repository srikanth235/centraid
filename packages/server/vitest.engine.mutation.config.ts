import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/server/engine-mutation",
    environment: "node",
    pool: "forks",
    include: ["src/engine/pricing/cost-properties.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
