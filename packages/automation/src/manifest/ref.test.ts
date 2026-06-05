import { describe, expect, it } from 'vitest';
import { formatRef, isValidId, isValidRef, parseRef } from './ref.js';

describe('isValidId', () => {
  it('accepts filesystem-safe slugs', () => {
    expect(isValidId('daily-digest')).toBe(true);
    expect(isValidId('summarize_prs')).toBe(true);
    expect(isValidId('Auto123')).toBe(true);
  });

  it('rejects empty / path-unsafe ids', () => {
    expect(isValidId('')).toBe(false);
    expect(isValidId('has space')).toBe(false);
    expect(isValidId('../escape')).toBe(false);
    expect(isValidId('dot.dot')).toBe(false);
  });
});

describe('automation refs', () => {
  it('formats and parses the canonical <appId>/<id> handle', () => {
    expect(formatRef('standup-bot', 'job')).toBe('standup-bot/job');
    expect(parseRef('standup-bot/job')).toEqual({
      appId: 'standup-bot',
      automationId: 'job',
    });
  });

  it('resolves a bare id against withinApp', () => {
    expect(parseRef('sibling', 'crm')).toEqual({
      appId: 'crm',
      automationId: 'sibling',
    });
    expect(parseRef('sibling')).toBe(undefined);
  });

  it('isValidRef accepts both forms, rejects malformed', () => {
    expect(isValidRef('standup/job')).toBe(true);
    expect(isValidRef('job')).toBe(true);
    expect(isValidRef('a/b/c')).toBe(false);
    expect(isValidRef('standup/has space')).toBe(false);
  });
});
