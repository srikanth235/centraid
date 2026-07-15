#!/usr/bin/env node
// One-command PWA fast-path perf run (issue #404 workstream I).
//
// Rebuilds the web dist (so the iroh timing instrumentation in
// src/iroh-transport.ts is in the bundle — the committed dist is gitignored and
// may predate it), then runs the perf-waterfall Playwright spec against the e2e
// harness gateway. Prints the measured baseline and writes
// apps/web/test-results/perf-waterfall-report.json.
//
// PREREQUISITE: the package dists the harness loads (gateway, app-engine) must
// already be built — run `bun run build` (or `bun run --cwd packages/gateway
// build`) from the repo root first, exactly like the e2e job does. This script
// only rebuilds the WEB dist, which is the piece the perf spec's instrumentation
// depends on.
//
// Usage:
//   node scripts/perf/run-waterfall.mjs            # all perf tests
//   node scripts/perf/run-waterfall.mjs --shell    # just the waterfall test
//   PWDEBUG=1 node scripts/perf/run-waterfall.mjs  # headed / inspector
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../../apps/web');

const grepShell = process.argv.includes('--shell');

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}  (cwd=${webDir})`);
  execFileSync(cmd, args, { cwd: webDir, stdio: 'inherit' });
}

// 1. Fresh web dist so the bundle carries the current iroh-transport timing marks.
run('bunx', ['vite', 'build']);

// 2. Run the perf spec under the same Playwright config as the rest of the e2e suite.
const testArgs = ['playwright', 'test', 'perf-waterfall', '-c', 'tests/e2e/playwright.config.ts'];
if (grepShell) testArgs.push('-g', 'app-open waterfall');
run('bunx', testArgs);

console.log(
  '\nReport: apps/web/test-results/perf-waterfall-report.json' +
    '\nSummary: node scripts/perf/summarize.mjs',
);
