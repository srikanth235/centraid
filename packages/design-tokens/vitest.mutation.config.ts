import { defineConfig } from "vitest/config";

/** Standalone Stryker test root for token value logic (defineConfig, not defineProject). */
export default defineConfig({
  test: {
    name: "design-tokens-mutation",
    environment: "node",
    pool: "forks",
    include: ["src/css-properties.test.ts", "src/tile-properties.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
