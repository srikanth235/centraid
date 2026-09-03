import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@centraid/mobile-mutation",
    environment: "node",
    pool: "forks",
    globals: true,
    include: [
      "src/lib/backoff.test.ts",
      "src/lib/coalesce.test.ts",
      "src/lib/conditional-fetch.test.ts",
      "src/lib/notification-model.test.ts",
      "src/lib/notifications-plan.test.ts",
      "src/lib/phone-link.test.ts",
      "src/lib/upload/transfer-policy.test.ts",
      "src/lib/upload/reconcile-gate.test.ts",
      "src/lib/replica/background-scopes.test.ts",
      "src/lib/replica/mobile-intent-id.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
