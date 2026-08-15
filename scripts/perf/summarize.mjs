#!/usr/bin/env node
// Pretty-print the JSON report written by perf-waterfall.spec.ts as a compact
// table, so a human (or a CI log reader) can eyeball the baseline without
// wading through the raw resource list. Read-only; makes no assertions.
//
// Usage: node scripts/perf/summarize.mjs [path-to-report.json]
import { readFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const reportPath =
  process.argv[2] ??
  path.resolve(here, "../../apps/web/test-results/perf-waterfall-report.json");

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
  console.error(`Could not read report at ${reportPath}: ${error.message}`);
  console.error("Run `node scripts/perf/run-waterfall.mjs` first.");
  process.exit(1);
}

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

console.log(`\nPWA fast-path waterfall — captured ${report.capturedAt}`);
console.log(
  `harness: ${report.harness.apiUrl}  app: ${report.harness.appId}\n`
);

// `transfer` is wire bytes; `encoded` is the compressed weight of the same
// bodies whether they came off the wire or out of the service-worker cache.
// An app open on a warm shell transfers 0 and still loads real weight, so the
// two columns are both shown rather than collapsed (the app-open warm/cold
// ratio is over `encoded` — see apps/web/tests/e2e/perf-budgets.ts).
const rows = [
  ["phase", "requests", "transfer", "encoded", "warm/cold"],
  [
    "shell cold",
    report.shell.cold.requestCount,
    kb(report.shell.cold.transferBytes),
    "",
    "",
  ],
  [
    "shell warm",
    report.shell.warm.requestCount,
    kb(report.shell.warm.transferBytes),
    "",
    String(report.shell.warmToColdByteRatio),
  ],
  [
    "app cold",
    report.appOpen.cold.requestCount,
    kb(report.appOpen.cold.grandTotalTransferBytes),
    kb(report.appOpen.cold.encodedBodyBytes),
    "",
  ],
  [
    "app warm",
    report.appOpen.warm.requestCount,
    kb(report.appOpen.warm.grandTotalTransferBytes),
    kb(report.appOpen.warm.encodedBodyBytes),
    String(report.appOpen.warmToColdByteRatio),
  ],
];

const widths = rows[0].map((_, col) =>
  Math.max(...rows.map((r) => String(r[col]).length))
);
for (const row of rows) {
  console.log(
    row.map((cell, col) => String(cell).padEnd(widths[col])).join("  ")
  );
}
console.log(
  `\napp cold elapsed: ${report.appOpen.cold.elapsedMs}ms  warm: ${report.appOpen.warm.elapsedMs}ms`
);
