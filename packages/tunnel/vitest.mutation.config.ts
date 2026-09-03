import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/tunnel-mutation",
    environment: "node",
    pool: "forks",
    include: ["src/wire-properties.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
