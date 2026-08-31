import { defineConfig } from "vitest/config";

/**
 * Standalone Stryker test root for the phone's pure `src/lib` logic (#839).
 *
 * Deliberately NOT `vitest.config.ts`: that config composes both mobile
 * projects, and the second one pulls the whole React Native source tree
 * through a Babel transform for one component suite — minutes of work per
 * mutant, for modules none of these mutants touch. The mutate set here is the
 * import-free/near-import-free half of `src/lib`, so a plain node project runs
 * it.
 */
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
      // #892 — the upload and replica halves. Plain node suites over
      // import-free modules, which is what lets them run here at all.
      "src/lib/upload/transfer-policy.test.ts",
      "src/lib/upload/reconcile-gate.test.ts",
      "src/lib/replica/background-scopes.test.ts",
      "src/lib/replica/mobile-intent-id.test.ts",
    ],
    testTimeout: 60_000,
    expect: { requireAssertions: true },
  },
});
