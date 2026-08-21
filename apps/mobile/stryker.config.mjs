/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: [
    "src/lib/backoff.test.ts",
    "src/lib/coalesce.test.ts",
    "src/lib/conditional-fetch.test.ts",
    "src/lib/notification-model.test.ts",
    "src/lib/notifications-plan.test.ts",
    "src/lib/phone-link.test.ts",
  ],
  // The phone's OWN decisions, as opposed to the phone's rendering: what to
  // notify and when to stop (`notifications-plan`), how long to wait before
  // trying the gateway again (`backoff`), how to collapse a burst of wakeups
  // into one unit of work (`coalesce`), when a cached body may stand in for a
  // fetch (`conditional-fetch`), and how the paired-vault list is normalized
  // (`phone-link-core`). Each is pure in/out with a sibling behavioural suite,
  // and each is a rule that is WRONG rather than merely ugly when it drifts —
  // a duplicate notification, a thundering-herd retry, a stale body served as
  // fresh, a paired vault silently dropped.
  //
  // Deliberately OUT — native reach: `daily-brief.ts` / `secure-storage.ts` /
  // `gateway.ts` import expo-notifications, expo-secure-store and
  // AsyncStorage, so mutating them measures the mocks rather than the phone;
  // the `.tsx` screens and `notifications.tsx` are rendering; `src/replica` is
  // the client package's engine wearing a mobile driver and is seeded there.
  //
  // Deliberately OUT — not yet defended (#839): `notification-model.ts`
  // measured 57.1% with 24 of its 98 mutants NEVER EXECUTED by its own suite,
  // and `phone-link-parse.ts` measured 60.7% with the base64url→base64
  // transport decode entirely unasserted (the suite pins parse OUTCOMES, not
  // the decode). Both belong in this mutate set once a law covers those
  // paths; seeding them today would only ratchet in the hole.
  mutate: [
    "src/lib/backoff.ts",
    "src/lib/coalesce.ts",
    "src/lib/conditional-fetch.ts",
    "src/lib/notifications-plan.ts",
    "src/lib/phone-link-core.ts",
  ],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/mobile-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
