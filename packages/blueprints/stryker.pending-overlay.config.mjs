/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: {
    configFile: "vitest.pending-overlay.mutation.config.ts",
    related: false,
  },
  testFiles: [
    "apps/_shared/pending-overlay.test.ts",
    "apps/_shared/pending-overlay-law.test.ts",
    "apps/_shared/pending-overlay-presentation.test.ts",
  ],
  // The one engine that decides what a member sees between pressing a control
  // and the vault answering (#738): which pending intent decorates which row,
  // what a retained failure may still offer (retry / discard), and when an
  // overlay expires. Every seat — desktop, web, phone — paints from this, so a
  // mutation that survives here is a row that lies on three surfaces at once.
  //
  // Deliberately OUT: `pending-projections.ts` (a registry that is nothing but
  // a module-scope Map — `ignoreStatic` discards its mutants, so it would
  // score 0 and say nothing) and the per-app `pending-projection.ts` adapters,
  // which are declaration tables of the same shape.
  mutate: ["apps/_shared/pending-overlay.ts"],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/pending-overlay-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
