/**
 * Automations missed-window scan at volume (#496 PE2).
 *
 * Measures `computeMissedWindows` across many automations and a multi-hour
 * downtime gap: records at most one missed window per automation (no
 * minute-by-minute backfill storm). Uses hourly crons so the scan must walk
 * real minutes (every-minute crons break on the first iteration and measure
 * the best case, not volume).
 *
 * This is the ledger/scan path — not live fire of automations (that lives in
 * lifecycle + in-process scheduler tests). Matrix cell name is honest about
 * "missed-window scan", not "fire".
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
    // Every 15 minutes — forces multiple scan iterations before the first
    // match (every-minute `* * * * *` exits on iteration 1 and measures the
    // best case). cronMatches uses local wall clock, so we do not pin an
    // absolute UTC scheduledFor.
    crons: ['*/15 * * * *'] as const,
  }));

  const started = performance.now();
  const missed = computeMissedWindows({ lastTickAt, now, entries });
  const durationMs = performance.now() - started;

  // Exactly one earliest missed window per automation — never 360 * N.
  expect(missed).toHaveLength(AUTOMATION_COUNT);
  const seen = new Set<string>();
  const gapStart = lastTickAt.getTime();
  const gapEnd = now.getTime();
  for (const entry of missed) {
    expect(entry.reason).toBe('gateway-down');
    expect(entry.automationRef.startsWith('auto-')).toBe(true);
    expect(seen.has(entry.automationRef)).toBe(false);
    seen.add(entry.automationRef);
    const at = Date.parse(entry.scheduledFor);
    expect(at).toBeGreaterThan(gapStart);
    expect(at).toBeLessThan(gapEnd);
  }
  // Storm cap: one per automation is the product policy. A one-per-minute
  // backfill would yield ~360 * N — assert we are nowhere near that.
  expect(missed.length).toBe(AUTOMATION_COUNT);
  expect(missed.length).toBeLessThan(360 * AUTOMATION_COUNT);

  const passed = durationMs < BUDGET_MS && missed.length === AUTOMATION_COUNT;
  await recordQualityResult({
    lane: 'scale',
    owner: OWNER,
    name: `Automations missed-window scan (${AUTOMATION_COUNT} autos, 6h gap, hourly cron)`,
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'wall clock', value: durationMs, unit: 'ms', budget: BUDGET_MS },
      { name: 'missed entries', value: missed.length, unit: 'count' },
    ],
  });
  expect(durationMs).toBeLessThan(BUDGET_MS);
});
