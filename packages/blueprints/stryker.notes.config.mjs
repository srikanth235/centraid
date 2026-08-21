/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.notes.mutation.config.ts", related: false },
  testFiles: [
    "apps/notes/logic.test.ts",
    "apps/notes/format.test.ts",
    "apps/notes/shelves.test.ts",
    "apps/notes/send-to-tasks.test.ts",
    "apps/notes/powerbox.test.ts",
    "apps/notes/commonmark.test.ts",
  ],
  // Notes' decisions. `logic.ts` is every vault read and write the app makes
  // plus the library's own derivations, and the rule it carries is which of
  // the three outcomes a member is shown — a park narrated as a failure, or a
  // denial narrated as "nothing matches", are both defects a rendering test
  // cannot see. `format.ts` is first-line promotion and the checklist tally
  // (over half the corpus has no title of its own, so every card reads it),
  // `send-to-tasks.ts` is the date a note line carries, `shelves.ts` the
  // ten-route round trip, `powerbox.ts` the `[[` candidate grouping, and
  // `commonmark.ts` the portable-source normalization.
  //
  // Deliberately OUT: `view-copy.ts` (a copy table — `ignoreStatic` discards
  // module-scope mutants), `app-root.tsx` / `frame.tsx` / `Chrome.tsx` /
  // `components/` (rendering), and `queries/` (they run against a real
  // gateway, not in this test root).
  mutate: [
    "apps/notes/logic.ts",
    "apps/notes/format.ts",
    "apps/notes/shelves.ts",
    "apps/notes/send-to-tasks.ts",
    "apps/notes/powerbox.ts",
    "apps/notes/commonmark.ts",
  ],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/notes-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
