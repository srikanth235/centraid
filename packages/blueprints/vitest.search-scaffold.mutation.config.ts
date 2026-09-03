import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints/search-scaffold-mutation",
    environment: "node",
    pool: "forks",
    include: ["apps/_shared/search-scaffold.test.ts"],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
