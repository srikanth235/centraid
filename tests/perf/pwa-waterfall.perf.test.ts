import { readFile } from 'node:fs/promises';
import { perfBudgets } from '../../apps/web/tests/e2e/perf-budgets.js';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { expect, test } from 'vitest';

const OWNER = 'tests/perf/pwa-waterfall.perf.test.ts';
// Produced by the web-e2e Playwright job (perf-waterfall.spec.ts) and handed to
// this lane as an artifact. This is a CHROMIUM PWA request-waterfall report, not
// an on-device mobile measurement — the file was previously mislabeled
// "mobile-fast-path"; it gates web.performance, and mobile.performance stays a
// gap (see tests/matrix.json notes) until real on-device budgets exist.
const input = 'artifacts/perf-input/pwa-waterfall-report.json';

interface WaterfallReport {
  shell: {
    cold: { requestCount: number; transferBytes: number };
    warmToColdByteRatio: number;
  };
  appOpen: {
    cold: { requestCount: number; grandTotalTransferBytes: number; elapsedMs: number };
    warm: { requestCount: number; grandTotalTransferBytes: number; elapsedMs: number };
    warmToColdByteRatio: number;
  };
}

async function readWaterfall(): Promise<WaterfallReport | undefined> {
  try {
    return JSON.parse(await readFile(input, 'utf8')) as WaterfallReport;
  } catch {
    return undefined;
  }
}

const waterfall = await readWaterfall();

// The artifact is only ever missing when the upstream web-e2e job did not run or
// failed to publish it. Locally that is expected (skip). In CI it means the gate
// silently guarded nothing — the exact defect this reorg is closing — so fail
// hard instead of skipping into a false green.
if (process.env.CI && !waterfall) {
  throw new Error(
    `${OWNER}: missing ${input}. The nightly web-e2e job must publish the PWA ` +
      `waterfall report before the perf lane runs; a missing artifact is a hard ` +
      `failure in CI (it would otherwise gate nothing).`,
  );
}

test.skipIf(!waterfall)(
  'the real #404 PWA fast-path browser budgets gate the nightly lane',
  async () => {
    const report = waterfall!;
    const passed =
      report.shell.cold.requestCount <= perfBudgets.shell.maxRequests &&
      report.shell.cold.transferBytes <= perfBudgets.shell.maxTransferBytes &&
      report.shell.warmToColdByteRatio <= perfBudgets.shell.maxWarmToColdByteRatio &&
      report.appOpen.cold.requestCount <= perfBudgets.appOpen.cold.maxRequests &&
      report.appOpen.cold.grandTotalTransferBytes <= perfBudgets.appOpen.cold.maxTransferBytes &&
      report.appOpen.warm.requestCount <= perfBudgets.appOpen.warm.maxRequests &&
      report.appOpen.warm.grandTotalTransferBytes <= perfBudgets.appOpen.warm.maxTransferBytes &&
      report.appOpen.warmToColdByteRatio <= perfBudgets.appOpen.maxWarmToColdByteRatio;
    await recordQualityResult({
      lane: 'perf',
      owner: OWNER,
      name: '#404 PWA fast-path waterfall',
      status: passed ? 'passed' : 'failed',
      measurements: [
        {
          name: 'cold shell requests',
          value: report.shell.cold.requestCount,
          unit: 'requests',
          budget: perfBudgets.shell.maxRequests,
        },
        {
          name: 'cold shell transfer',
          value: report.shell.cold.transferBytes,
          unit: 'bytes',
          budget: perfBudgets.shell.maxTransferBytes,
        },
        {
          name: 'warm/cold shell bytes',
          value: report.shell.warmToColdByteRatio,
          unit: 'ratio',
          budget: perfBudgets.shell.maxWarmToColdByteRatio,
        },
        {
          name: 'cold app requests',
          value: report.appOpen.cold.requestCount,
          unit: 'requests',
          budget: perfBudgets.appOpen.cold.maxRequests,
        },
        {
          name: 'cold app transfer',
          value: report.appOpen.cold.grandTotalTransferBytes,
          unit: 'bytes',
          budget: perfBudgets.appOpen.cold.maxTransferBytes,
        },
      ],
    });
    expect(passed).toBe(true);
  },
);
