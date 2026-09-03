import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/core/blob-mutation",
    environment: "node",
    pool: "forks",
    include: ["src/blob/cbsf-properties.test.ts", "src/blob/cbsf.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
