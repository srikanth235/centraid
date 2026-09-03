import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints/agenda-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "apps/agenda/logic.test.ts",
      "apps/agenda/logic-search.test.ts",
      "apps/agenda/edits.test.ts",
      "apps/agenda/views.test.ts",
      "apps/agenda/day-context.test.ts",
      "apps/agenda/view-copy.test.ts",
      "apps/agenda/format-locale.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
