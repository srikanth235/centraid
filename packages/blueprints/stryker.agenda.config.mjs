/** Package-local Stryker options (types from root @stryker-mutator/core). */
export default {
  packageManager: "npm",
  testRunner: "vitest",
  vitest: { configFile: "vitest.agenda.mutation.config.ts", related: false },
  testFiles: [
    "apps/agenda/logic.test.ts",
    "apps/agenda/logic-search.test.ts",
    "apps/agenda/edits.test.ts",
    "apps/agenda/views.test.ts",
    "apps/agenda/day-context.test.ts",
    "apps/agenda/view-copy.test.ts",
  ],
  // Agenda's arithmetic and its narration. `views.ts` decides which day an
  // event is drawn on, what counts as all-day and how a multi-day run lays
  // out — a calendar that puts an event on the wrong day is not a cosmetic
  // defect. `logic.ts` is the vault IO plus the rule that a PARK IS NOT A
  // FAILURE (cancelling parks by design, so mis-narrating it is the defect
  // this seed most exists to catch). `edits.ts` is the optimistic RSVP
  // projection and the scope-panel mapping; `day-context.ts` derives the
  // day's own facts.
  //
  // Deliberately OUT: `format.ts` (no suite of its own yet — its callers are
  // asserted through views/day-context, so mutating it would ratchet in a
  // hole rather than close one), `view-copy.ts` (a copy table, discarded by
  // `ignoreStatic`), `app-root.tsx` / `frame.tsx` / `Chrome.tsx` /
  // `components/` (rendering) and `queries/` (real gateway).
  mutate: [
    "apps/agenda/logic.ts",
    "apps/agenda/edits.ts",
    "apps/agenda/views.ts",
    "apps/agenda/day-context.ts",
  ],
  reporters: ["clear-text", "json"],
  jsonReporter: {
    fileName: "../../artifacts/mutation/agenda-report.json",
  },
  thresholds: { high: 80, low: 50, break: null },
  timeoutMS: 60_000,
  concurrency: 2,
  ignoreStatic: true,
  disableTypeChecks: true,
};
