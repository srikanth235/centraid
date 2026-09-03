import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints/notes-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "apps/notes/logic.test.ts",
      "apps/notes/logic-commands.test.ts",
      "apps/notes/logic-panes.test.ts",
      "apps/notes/format.test.ts",
      "apps/notes/shelves.test.ts",
      "apps/notes/send-to-tasks.test.ts",
      "apps/notes/powerbox.test.ts",
      "apps/notes/commonmark.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
