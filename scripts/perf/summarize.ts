#!/usr/bin/env node
// Pretty-print the JSON report written by perf-waterfall.spec.ts as a compact
// table, so a human (or a CI log reader) can eyeball the baseline without
// wading through the raw resource list. Read-only; makes no assertions.
//
// Usage: node scripts/perf/summarize.ts [path-to-report.json]
import { readFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const reportPath =
  process.argv[2] ??
  path.resolve(here, "../../apps/web/test-results/perf-waterfall-report.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPhase(value: unknown): {
  requestCount: unknown;
  transferBytes: unknown;
  grandTotalTransferBytes: unknown;
  encodedBodyBytes: unknown;
  elapsedMs: unknown;
} {
  const record = isRecord(value) ? value : {};
  return {
    requestCount: record.requestCount,
    transferBytes: record.transferBytes,
    grandTotalTransferBytes: record.grandTotalTransferBytes,
    encodedBodyBytes: record.encodedBodyBytes,
    elapsedMs: record.elapsedMs,
  };
}

let report: unknown;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8")) as unknown;
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Could not read report at ${reportPath}: ${message}`);
  console.error("Run `node scripts/perf/run-waterfall.ts` first.");
  process.exit(1);
}

// `encoded` only exists in reports written after #799 retired the served-app
// plane; print a dash rather than `NaN KB` when summarizing an older artifact.
const kb = (n: unknown) =>
  typeof n === "number" ? `${(n / 1024).toFixed(1)} KB` : "—";

if (!isRecord(report)) {
  console.error("perf report is not an object");
  process.exit(1);
}
const harness = isRecord(report.harness) ? report.harness : {};
const shell = isRecord(report.shell) ? report.shell : {};
const appOpen = isRecord(report.appOpen) ? report.appOpen : {};
const shellCold = asPhase(shell.cold);
const shellWarm = asPhase(shell.warm);
const appCold = asPhase(appOpen.cold);
const appWarm = asPhase(appOpen.warm);

console.log(
  `\nPWA fast-path waterfall — captured ${String(report.capturedAt)}`
);
console.log(
  `harness: ${String(harness.apiUrl)}  app: ${String(harness.appId)}\n`
);

// `transfer` is wire bytes; `encoded` is the DECODED weight of the same bodies
// whether they came off the wire or out of the service-worker cache (Cache
// Storage holds decoded bodies, so it is raw size, never a wire figure).
// An app open on a warm shell transfers 0 and still loads real weight, so the
// two columns are both shown rather than collapsed (the app-open warm/cold
// ratio is over `encoded` — see apps/web/tests/e2e/perf-budgets.ts).
const rows = [
  ["phase", "requests", "transfer", "encoded", "warm/cold"],
  ["shell cold", shellCold.requestCount, kb(shellCold.transferBytes), "", ""],
  [
    "shell warm",
    shellWarm.requestCount,
    kb(shellWarm.transferBytes),
    "",
    String(shell.warmToColdByteRatio),
  ],
  [
    "app cold",
    appCold.requestCount,
    kb(appCold.grandTotalTransferBytes),
    kb(appCold.encodedBodyBytes),
    "",
  ],
  [
    "app warm",
    appWarm.requestCount,
    kb(appWarm.grandTotalTransferBytes),
    kb(appWarm.encodedBodyBytes),
    String(appOpen.warmToColdByteRatio),
  ],
];

const header = rows[0];
if (header === undefined) {
  throw new Error("perf summary table is empty");
}
const widths = header.map((_, col) =>
  Math.max(...rows.map((r) => String(r[col]).length))
);
for (const row of rows) {
  console.log(
    row.map((cell, col) => String(cell).padEnd(widths[col] ?? 0)).join("  ")
  );
}
console.log(
  `\napp cold elapsed: ${String(appCold.elapsedMs)}ms  warm: ${String(appWarm.elapsedMs)}ms`
);
