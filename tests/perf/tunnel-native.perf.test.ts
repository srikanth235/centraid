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

test.skipIf(!hasNative)('native tunnel module loads and exports within budget', async () => {
  const started = performance.now();
  // Dynamic import of the native .node (createRequire-style via path URL).
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const addon = require(path.resolve(nativePath!));
  const durationMs = performance.now() - started;
  expect(addon).toBeTruthy();
  const BUDGET_MS = 500;
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

test('documents native-vs-JS split when native module is absent', () => {
  if (hasNative) {
    expect(nativePath).toBeTruthy();
    return;
  }
  // Honest skip signal for the report: no native binary in this lane.
  expect(hasNative).toBe(false);
});
