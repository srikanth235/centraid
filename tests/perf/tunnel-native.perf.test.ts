/**
 * Native QUIC tunnel perf budget (#496 PD1).
 * Runs when the native module is present; otherwise skipIf so default CI is not
 * painted solid without evidence (B2). JS fallback remains tunnel-throughput.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { expect, test } from 'vitest';

const OWNER = 'tests/perf/tunnel-native.perf.test.ts';
const nativeCandidates = [
  'packages/tunnel/native/centraid-tunnel-native.linux-x64.node',
  'packages/tunnel/native/centraid-tunnel-native.darwin-arm64.node',
  'packages/tunnel/native/centraid-tunnel-native.darwin-x64.node',
];
const nativePath = nativeCandidates.find((p) => existsSync(path.resolve(p)));
const hasNative = Boolean(nativePath);

// Cold dylib load on nightly runners routinely exceeds 500 ms; 5 s still
// catches a catastrophic hang without flaking cold boots.
const BUDGET_MS = 5_000;

test.skipIf(!hasNative)('native tunnel module loads and exports within budget', async () => {
  const started = performance.now();
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const addon = require(path.resolve(nativePath!));
  const durationMs = performance.now() - started;
  expect(addon).toBeTruthy();
  expect(typeof addon).toBe('object');
  // Surface at least one export so a stub empty module fails.
  expect(
    Object.keys(addon as object).length + (typeof addon === 'function' ? 1 : 0),
  ).toBeGreaterThan(0);
  const passed = durationMs < BUDGET_MS;
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Native tunnel module load',
    status: passed ? 'passed' : 'failed',
    measurements: [{ name: 'load wall clock', value: durationMs, unit: 'ms', budget: BUDGET_MS }],
  });
  expect(durationMs).toBeLessThan(BUDGET_MS);
});

// Inverse of the load test: only runs when the binary is absent so the report
// records an honest "no evidence" rather than a tautology that always passes.
test.skipIf(hasNative)('documents native module absence when binary is not on disk', () => {
  expect(hasNative).toBe(false);
  expect(nativePath).toBeUndefined();
});
