import { readFile } from 'node:fs/promises';
import { perfBudgets } from '../../apps/web/tests/e2e/perf-budgets.js';
import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { expect, test } from 'vitest';

const OWNER = 'tests/perf/mobile-fast-path.perf.test.ts';
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

test.skipIf(!waterfall)(
  'the real #404 PWA/mobile fast-path browser budgets gate the nightly lane',
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
      name: '#404 PWA/mobile fast-path waterfall',
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
