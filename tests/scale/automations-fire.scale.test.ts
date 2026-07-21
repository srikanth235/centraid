/**
 * Automations fire-at-volume (#496 PE2).
 * Drives real `computeMissedWindows` across many automations and a multi-hour
 * downtime gap: records at most one missed window per automation (no
 * minute-by-minute backfill storm).
 */
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { computeMissedWindows } from '../../packages/automation/src/fire/scheduler-ledger.js';
import { expect, test } from 'vitest';

const OWNER = 'tests/scale/automations-fire.scale.test.ts';
const AUTOMATION_COUNT = 200;
const BUDGET_MS = 10_000;

test('computeMissedWindows at volume: one entry per automation, no backfill storm', async () => {
  const lastTickAt = new Date('2026-01-01T00:00:00.000Z');
  // 6 hours down — would be 360 missed minutes if we backfilled every minute.
  const now = new Date('2026-01-01T06:00:00.000Z');
  const entries = Array.from({ length: AUTOMATION_COUNT }, (_, i) => ({
    ref: `auto-${i}`,
    // Every minute — worst-case match density for the scan.
    crons: ['* * * * *'] as const,
  }));

  const started = performance.now();
  const missed = computeMissedWindows({ lastTickAt, now, entries });
  const durationMs = performance.now() - started;

  // Exactly one earliest missed window per automation — never 360 * N.
  expect(missed).toHaveLength(AUTOMATION_COUNT);
  for (const entry of missed) {
    expect(entry.reason).toBe('gateway-down');
    expect(entry.automationRef.startsWith('auto-')).toBe(true);
  }
  // Cap is far below a backfill of every missed minute.
  expect(missed.length).toBeLessThan(AUTOMATION_COUNT * 10);

  const passed = durationMs < BUDGET_MS && missed.length === AUTOMATION_COUNT;
  await recordQualityResult({
    lane: 'scale',
    owner: OWNER,
    name: `Automations missed-window scan (${AUTOMATION_COUNT} autos, 6h gap)`,
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'wall clock', value: durationMs, unit: 'ms', budget: BUDGET_MS },
      { name: 'missed entries', value: missed.length, unit: 'count' },
    ],
  });
  expect(durationMs).toBeLessThan(BUDGET_MS);
});
