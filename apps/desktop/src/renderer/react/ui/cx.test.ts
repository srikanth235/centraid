import { describe, expect, it } from 'vitest';
import { cx } from './cx.js';

describe('cx', () => {
  it('joins truthy string args with spaces', () => {
    expect(cx('a', 'b', 'c')).toBe('a b c');
  });

  it('skips falsy values', () => {
    expect(cx('a', false, null, undefined, '', 'b')).toBe('a b');
  });

  it('applies object entries whose value is truthy', () => {
    expect(cx('base', { active: true, disabled: false, big: true })).toBe('base active big');
  });

  it('supports conditional variant patterns', () => {
    const variant = 'primary';
    expect(cx('cd-btn', { 'cd-btn-primary': variant === 'primary' })).toBe('cd-btn cd-btn-primary');
  });

  it('returns an empty string when nothing is truthy', () => {
    expect(cx(false, null, undefined, { off: false })).toBe('');
  });

  it('stringifies numbers', () => {
    expect(cx('col', 0, 3)).toBe('col 3');
  });
});
