/**
 * Desktop cold-path budget (#496 PD3).
 * Crude first-import proxy for desktop main modules (not full Electron launch).
 * Full Electron cold-start remains nightly Playwright; this owns the matrix cell
 * with a continuous, CI-runnable floor.
 */
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { expect, test } from 'vitest';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = 'tests/perf/desktop-cold.perf.test.ts';
const BUDGET_MS = 3_000;

test('desktop gateway-supervisor-core first import stays under budget', async () => {
  const started = performance.now();
  const modPath = path.resolve('apps/desktop/src/main/gateway-supervisor-core.ts');
  // Dynamic import of the pure core (no Electron). Timing is host-sensitive;
  // budget is a catastrophic-failure floor, not a tight CI gate.
  const url = pathToFileURL(modPath).href;
  const mod = await import(url);
  const durationMs = performance.now() - started;
  expect(mod).toBeTruthy();
  const passed = durationMs < BUDGET_MS;
  await recordQualityResult({
    lane: 'perf',
    owner: OWNER,
    name: 'Desktop cold module import',
    status: passed ? 'passed' : 'failed',
    measurements: [{ name: 'import wall clock', value: durationMs, unit: 'ms', budget: BUDGET_MS }],
  });
  expect(durationMs).toBeLessThan(BUDGET_MS);
});
