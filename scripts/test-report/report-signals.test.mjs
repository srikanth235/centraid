import { describe, expect, test } from 'vitest';
import {
  detectDefaultCiEnvGate,
  extractUnhandledErrors,
  summarizeCellStates,
} from './report-signals.mjs';

describe('extractUnhandledErrors', () => {
  test('reads explicit unhandledErrors array from vitest JSON', () => {
    const messages = extractUnhandledErrors({
      success: false,
      unhandledErrors: [{ message: 'write EPIPE' }, 'other'],
      testResults: [
        {
          status: 'passed',
          assertionResults: [{ status: 'passed' }],
        },
      ],
    });
    expect(messages).toContain('write EPIPE');
    expect(messages).toContain('other');
  });

  test('flags success=false with zero failed tests (EPIPE-class process fail)', () => {
    const messages = extractUnhandledErrors({
      success: false,
      testResults: [
        {
          status: 'passed',
          assertionResults: [{ status: 'passed' }, { status: 'passed' }],
        },
      ],
    });
    expect(messages.some((m) => /success=false|unhandled/i.test(m))).toBe(true);
  });

  test('does not invent errors when suite genuinely failed assertions', () => {
    const messages = extractUnhandledErrors({
      success: false,
      testResults: [
        {
          status: 'failed',
          assertionResults: [{ status: 'failed', fullName: 'x' }],
        },
      ],
    });
    expect(messages.every((m) => !/zero failed tests/i.test(m))).toBe(true);
  });
});

describe('summarizeCellStates', () => {
  test('separates failed from missing (lane ran vs not run)', () => {
    const counts = summarizeCellStates([
      { state: 'passed' },
      { state: 'failed' },
      { state: 'failed' },
      { state: 'missing' },
      { state: 'missing' },
      { state: 'missing' },
      { state: 'skipped' },
    ]);
    expect(counts.cellsFailed).toBe(2);
    expect(counts.cellsMissing).toBe(3);
    expect(counts.cellsPassed).toBe(1);
    expect(counts.cellsSkipped).toBe(1);
  });
});

describe('detectDefaultCiEnvGate', () => {
  test('detects describe.skipIf(process.env.X !== "1") whole-file gates', () => {
    const src = `import { describe } from 'vitest';
describe.skipIf(process.env.CENTRAID_RUN_NATIVE_TUNNEL !== '1')('native gateway relay', () => {
  test('x', () => {});
});
`;
    expect(detectDefaultCiEnvGate(src)).toEqual({
      env: 'CENTRAID_RUN_NATIVE_TUNNEL',
      kind: 'skipIf-env-not-1',
    });
  });

  test('detects env check + t.skip in the test body (disk-full pattern)', () => {
    const src = `
test('FsBlobStore.putSync against a REAL full filesystem', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('disk-full e2e only runs on darwin (hdiutil)');
    return;
  }
  if (process.env.CENTRAID_DISKFULL_E2E !== '1') {
    t.skip('set CENTRAID_DISKFULL_E2E=1 (on darwin) to run the real hdiutil disk-full e2e');
    return;
  }
  expect(true).toBe(true);
});
`;
    expect(detectDefaultCiEnvGate(src)).toEqual({
      env: 'CENTRAID_DISKFULL_E2E',
      kind: 'early-env-return',
    });
  });

  test('returns null for ordinary tests', () => {
    expect(detectDefaultCiEnvGate(`test('works', () => { expect(1).toBe(1); });`)).toBeNull();
  });
});
