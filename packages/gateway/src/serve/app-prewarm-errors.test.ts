import { describe, expect, test } from 'vitest';
import { isExpectedPrewarmSkip } from './app-prewarm-errors.js';

describe('isExpectedPrewarmSkip', () => {
  test('treats ENOENT code as expected (missing index in test vaults)', () => {
    const err = Object.assign(
      new Error("ENOENT: no such file or directory, open '.../index.html'"),
      {
        code: 'ENOENT',
      },
    );
    expect(isExpectedPrewarmSkip(err)).toBe(true);
  });

  test('treats message-only ENOENT strings as expected', () => {
    expect(isExpectedPrewarmSkip(new Error('no such file or directory, open index.html'))).toBe(
      true,
    );
  });

  test('does not swallow unexpected prewarm failures', () => {
    expect(isExpectedPrewarmSkip(new Error('esbuild failed: Unexpected token'))).toBe(false);
    expect(isExpectedPrewarmSkip(Object.assign(new Error('EACCES'), { code: 'EACCES' }))).toBe(
      false,
    );
    expect(isExpectedPrewarmSkip(null)).toBe(false);
  });
});
