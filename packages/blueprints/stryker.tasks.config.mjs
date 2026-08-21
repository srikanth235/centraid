/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.tasks.mutation.config.ts", related: false },
  testFiles: [
    "apps/tasks/logic.test.ts",
    "apps/tasks/format.test.ts",
    "apps/tasks/routes.test.ts",
    "apps/tasks/view-copy.test.ts",
  ],
  // The Tasks board's ANSWERS, not its paint. `when.ts` is the single
  // definition of the midnight problem (`landsToday`, date-only vs timed), and
  // it is import-free precisely so the shell tile and the phone read the same
  // predicate; `logic.ts` is the grouping/bucketing/board-state layer built on
  // it; `format.ts` turns a due value into the row's own words; `shelves.ts`
  // is the twelve-route round trip. Every one of these is wrong-or-right
  // rather than nicer-or-uglier: an undated task that touches Today, a
  // repeating task drawn four times, a route that does not round-trip.
  //
  // Deliberately OUT: `view-copy.ts` (a copy table — `ignoreStatic` discards
  // module-scope mutants, so it would contribute noise, and its own suite
  // already asserts the literals), `app-root.tsx` / `frame.tsx` / `Chrome.tsx`
  // / `components/` (rendering), `queries/` and `actions/` (they run against a
  // real gateway, not in this test root), and `scope-fanout.ts` /
  // `pending-projection.ts` (covered by the shared seeds for those engines).
  mutate: [
    "apps/tasks/logic.ts",
    "apps/tasks/when.ts",
    "apps/tasks/format.ts",
    "apps/tasks/shelves.ts",
  ],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/tasks-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
