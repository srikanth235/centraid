import { describe, expect, it } from 'vitest';
import {
  clearSlash,
  insertRef,
  mentionTokenAt,
  refString,
  slashCommandAt,
} from './composerMentions.js';

describe('mentionTokenAt', () => {
  it('detects an @token at a word boundary', () => {
    expect(mentionTokenAt('hello @ann', 10)).toEqual({ start: 6, query: 'ann' });
    expect(mentionTokenAt('@ann', 4)).toEqual({ start: 0, query: 'ann' });
    expect(mentionTokenAt('(@ann', 5)).toEqual({ start: 1, query: 'ann' });
  });
  it('rejects an @ mid-word, with whitespace, or over length', () => {
    expect(mentionTokenAt('email@x', 7)).toBeNull();
    expect(mentionTokenAt('@ann smith', 10)).toBeNull();
    expect(mentionTokenAt(`@${'a'.repeat(41)}`, 42)).toBeNull();
  });
  it('reads only up to the caret', () => {
    expect(mentionTokenAt('@annie', 3)).toEqual({ start: 0, query: 'an' });
  });
});

describe('slashCommandAt', () => {
  it('detects a leading /command word', () => {
    expect(slashCommandAt('/exp', 4)).toEqual({ start: 0, query: 'exp' });
    expect(slashCommandAt('/', 1)).toEqual({ start: 0, query: '' });
  });
  it('ignores a slash that is not first or has a space', () => {
    expect(slashCommandAt('a/b', 3)).toBeNull();
    expect(slashCommandAt('/export now', 11)).toBeNull();
  });
});

describe('refString + insertRef', () => {
  it('emits the canonical @[label](ref:type/id) format', () => {
    expect(refString('Ann Lee', 'core.party', 'p1')).toBe('@[Ann Lee](ref:core.party/p1)');
    // A stray ] in the label is stripped so the bracket stays valid.
    expect(refString('a]b', 'x.y', 'i')).toBe('@[ab](ref:x.y/i)');
    // Empty label falls back to type + id.
    expect(refString('  ', 'x.y', 'i')).toBe('@[x.y i](ref:x.y/i)');
  });
  it('splices the ref over the @token and returns the trailing caret', () => {
    const out = insertRef('see @an here', 4, 7, {
      label: 'Ann',
      type: 'core.party',
      id: 'p1',
    });
    expect(out.text).toBe('see @[Ann](ref:core.party/p1)  here');
    expect(out.caret).toBe(4 + '@[Ann](ref:core.party/p1) '.length);
  });
});

describe('clearSlash', () => {
  it('drops the leading /command up to the caret', () => {
    expect(clearSlash('/export', 7)).toBe('');
  });
});
