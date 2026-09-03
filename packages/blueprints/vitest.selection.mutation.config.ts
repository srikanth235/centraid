import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints/selection-mutation",
    environment: "node",
    pool: "forks",
    include: ["apps/_shared/selection-engine.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
