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
    // #892 Phase 2 — the two trees this cycle's defects actually lived in.
    "src/lib/upload/transfer-policy.test.ts",
    "src/lib/upload/reconcile-gate.test.ts",
    "src/lib/replica/background-scopes.test.ts",
    "src/lib/replica/mobile-intent-id.test.ts",
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
  // #892 Phase 2 — WIDENED TO WHERE THE DEFECTS WERE. The #890 audit found two
  // tests that could not fail — the `transfer-policy` scope loop and the replica
  // orphan check — and neither file was inside any seed's watch list. A mutation
  // adversary aimed only at where the tests were already good is a gate that
  // confirms its own priors; these four are the phone's upload and replica
  // decisions, and they are exactly the surfaces that audit found undefended:
  //
  //   transfer-policy   the gate that refuses an upload URL the gateway did not
  //                     mint. A mutant that survives here is an exfiltration
  //                     path, not a style nit.
  //   reconcile-gate    whether a wakeup does work at all — pure in/out.
  //   background-scopes which vaults a backgrounded phone keeps mounted under
  //                     the protocol's multiplex cap.
  //   mobile-intent-id  double-tap coalescing; the idempotency the replica's
  //                     write rail depends on.
  //
  // Still OUT of `src/lib/upload/`: everything importing expo-battery /
  // expo-network / the native module (`native-policy.ts`), the SQLite-backed
  // `store.ts`, and `uploader.ts`'s orchestration — mutating those measures the
  // mocks. Still OUT of `src/lib/replica/`: the native session and driver files,
  // for the same reason. `offline-budgets.ts` is module-scope constants, which
  // `ignoreStatic` discards, so seeding it would contribute zero mutants and say
  // nothing (the same reasoning that keeps `placement-registry.ts` out).
  mutate: [
    "src/lib/backoff.ts",
    "src/lib/coalesce.ts",
    "src/lib/conditional-fetch.ts",
    "src/lib/notifications-plan.ts",
    "src/lib/phone-link-core.ts",
    "src/lib/upload/transfer-policy.ts",
    "src/lib/upload/reconcile-gate.ts",
    "src/lib/replica/background-scopes.ts",
    "src/lib/replica/mobile-intent-id.ts",
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
