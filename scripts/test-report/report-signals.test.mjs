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

  test('returns null for ordinary tests', () => {
    expect(detectDefaultCiEnvGate(`test('works', () => { expect(1).toBe(1); });`)).toBeNull();
  });
});
