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
