/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.mutation.config.ts", related: false },
  testFiles: ["src/index.test.ts", "src/worker-guards.test.ts"],
  // A MUTATION RANGE, not the whole worker. `worker.ts` is one cohesive
  // security boundary, but most of it is I/O (upstream fetch, streamed body
  // reads, HTML pages, WebCrypto HMAC). Lines 836–916 are the pure predicate
  // block — validEnvironment, isLoopbackUrl, isLoopbackOrigin,
  // safeOAuthError, validatedScopes, sameScopes, bounded — every one of them
  // a total function of its arguments and every one of them defended by a
  // boundary law in `worker-guards.test.ts`.
  //
  // Deliberately OUT of the range: `base64Url{Encode,Decode}` and
  // `escapeHtml` (918–940). They are pure too, but their inputs are not
  // reachable from the HTTP surface in a shape that discriminates the mutants
  // (receipt bytes are HMAC-derived; the escaped strings are constants), so
  // including them would only depress the floor with mutants no honest law
  // can kill.
  //
  // The range is line-addressed, so `mutation-range.test.ts` asserts that
  // those line numbers still bracket exactly that block — a shift in
  // `worker.ts` fails the suite instead of silently mutating the wrong code.
  mutate: ["src/worker.ts:888-968"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/oauth-worker-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
