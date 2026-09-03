import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints/tasks-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "apps/tasks/logic.test.ts",
      "apps/tasks/format.test.ts",
      "apps/tasks/routes.test.ts",
      "apps/tasks/view-copy.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
