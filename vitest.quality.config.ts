import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "user-facing-qualities",
    include: ["tests/quality/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
