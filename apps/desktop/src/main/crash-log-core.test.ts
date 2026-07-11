import { describe, expect, it } from 'vitest';
import { formatCrashLine, shouldRotate, toCrashRecord } from './crash-log-core.js';

describe('toCrashRecord', () => {
  const now = () => new Date('2026-07-11T12:00:00.000Z');

  it('captures message + stack from a real Error', () => {
    const err = new Error('boom');
    const record = toCrashRecord('uncaughtException', err, now);
    expect(record.at).toBe('2026-07-11T12:00:00.000Z');
    expect(record.kind).toBe('uncaughtException');
    expect(record.message).toBe('boom');
    expect(record.stack).toContain('boom');
  });

  it('stringifies a non-Error rejection reason and omits stack', () => {
    const record = toCrashRecord('unhandledRejection', 'plain string reason', now);
    expect(record.message).toBe('plain string reason');
    expect(record.stack).toBeUndefined();
  });

  it('stringifies a thrown object', () => {
    const record = toCrashRecord('unhandledRejection', { code: 'E_WEIRD' }, now);
    expect(record.message).toBe('[object Object]');
  });
});

describe('formatCrashLine', () => {
  it('emits one newline-terminated JSON line', () => {
    const line = formatCrashLine({
      at: '2026-07-11T12:00:00.000Z',
      kind: 'uncaughtException',
      message: 'boom',
    });
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trimEnd())).toEqual({
      at: '2026-07-11T12:00:00.000Z',
      kind: 'uncaughtException',
      message: 'boom',
    });
  });
});

describe('shouldRotate', () => {
  it('rotates once size exceeds the cap, not at exactly the cap', () => {
    expect(shouldRotate(999, 1000)).toBe(false);
    expect(shouldRotate(1000, 1000)).toBe(false);
    expect(shouldRotate(1001, 1000)).toBe(true);
  });
});
