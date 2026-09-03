#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";

const here = import.meta.dirname;
const webDir = path.resolve(here, "../../apps/web");

const grepShell = process.argv.includes("--shell");

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(" ")}  (cwd=${webDir})`);
  execFileSync(cmd, args, { cwd: webDir, stdio: "inherit" });
}

run("bunx", ["vite", "build"]);

const testArgs = [
  "playwright",
  "test",
  "perf-waterfall",
  "-c",
  "tests/e2e/playwright.config.ts",
];
if (grepShell) testArgs.push("-g", "app-open waterfall");
run("bunx", testArgs);

console.log(
  "\nReport: apps/web/test-results/perf-waterfall-report.json" +
    "\nSummary: node scripts/perf/summarize.mjs"
);
