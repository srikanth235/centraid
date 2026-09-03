import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "fuzz-replay",
    include: ["scripts/fuzz/**/*.test.mjs"],
    environment: "node",
    pool: "forks",
    expect: { requireAssertions: true },
  },
});
