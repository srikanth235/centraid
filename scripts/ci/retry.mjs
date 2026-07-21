#!/usr/bin/env node
/**
 * E1 — bounded retry wrapper for flaky registry/network steps in CI.
 * Usage: node scripts/ci/retry.mjs [--attempts 3] [--delay-ms 2000] -- <command...>
 * Policy: flaky tests are bugs — do not use this around product tests; only
 * for install/download steps that fail on transient network.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
let attempts = 3;
let delayMs = 2000;
const cmd = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--attempts') attempts = Number(args[++i]);
  else if (args[i] === '--delay-ms') delayMs = Number(args[++i]);
  else if (args[i] === '--') {
    cmd.push(...args.slice(i + 1));
    break;
  } else {
    cmd.push(args[i]);
  }
}
if (cmd.length === 0) {
  console.error('usage: node scripts/ci/retry.mjs [--attempts N] -- <command>');
  process.exit(2);
}

for (let n = 1; n <= attempts; n++) {
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: false });
  if (r.status === 0) process.exit(0);
  console.error(`retry: attempt ${n}/${attempts} failed (exit ${r.status})`);
  if (n < attempts) {
    const wait = delayMs * n;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
}
process.exit(1);
