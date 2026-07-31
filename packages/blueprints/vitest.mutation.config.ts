import { defineConfig } from "vitest/config";

/** Standalone Stryker test root for the pure scaffold/rename builders. */
export default defineConfig({
  test: {
    name: "@centraid/blueprints-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "src/scaffold-files.test.ts",
      "src/scaffold-files-properties.test.ts",
      "src/app-rewrites.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
