import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/app-meta.test.ts",
      "src/app-meta-properties.test.ts",
      "src/app-rewrites.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
