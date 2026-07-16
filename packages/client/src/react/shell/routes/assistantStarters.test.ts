import { describe, expect, it } from 'vitest';
import { DEFAULT_STARTERS, resolveStarters } from './assistantStarters.js';

describe('resolveStarters', () => {
  it('returns defaults when the pref is absent or not an array', () => {
    expect(resolveStarters(undefined)).toEqual([...DEFAULT_STARTERS]);
    expect(resolveStarters({})).toEqual([...DEFAULT_STARTERS]);
    expect(resolveStarters({ 'assistant.starters': 'nope' })).toEqual([...DEFAULT_STARTERS]);
  });

  it('uses configured starters, trimming blanks and capping at 8', () => {
    expect(resolveStarters({ 'assistant.starters': ['One', '  Two  ', '', 3] })).toEqual([
      'One',
      'Two',
    ]);
    const many = Array.from({ length: 12 }, (_, i) => `S${i}`);
    expect(resolveStarters({ 'assistant.starters': many })).toHaveLength(8);
  });

  it('falls back to defaults when the configured list is all blanks', () => {
    expect(resolveStarters({ 'assistant.starters': ['', '   '] })).toEqual([...DEFAULT_STARTERS]);
  });
});
