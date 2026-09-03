import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/blueprints/pending-overlay-mutation",
    environment: "node",
    pool: "forks",
    include: [
      "apps/_shared/pending-overlay.test.ts",
      "apps/_shared/pending-overlay-law.test.ts",
      "apps/_shared/pending-overlay-presentation.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
