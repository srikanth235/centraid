import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { formatRef, isValidId, isValidRef, parseRef } from './ref.js';

describe('isValidId', () => {
  it('accepts filesystem-safe slugs', () => {
    assert.equal(isValidId('daily-digest'), true);
    assert.equal(isValidId('summarize_prs'), true);
    assert.equal(isValidId('Auto123'), true);
  });

  it('rejects empty / path-unsafe ids', () => {
    assert.equal(isValidId(''), false);
    assert.equal(isValidId('has space'), false);
    assert.equal(isValidId('../escape'), false);
    assert.equal(isValidId('dot.dot'), false);
  });
});

describe('automation refs', () => {
  it('formats and parses the canonical <appId>/<id> handle', () => {
    assert.equal(formatRef('standup-bot', 'job'), 'standup-bot/job');
    assert.deepEqual(parseRef('standup-bot/job'), {
      appId: 'standup-bot',
      automationId: 'job',
    });
  });

  it('resolves a bare id against withinApp', () => {
    assert.deepEqual(parseRef('sibling', 'crm'), {
      appId: 'crm',
      automationId: 'sibling',
    });
    assert.equal(parseRef('sibling'), undefined);
  });

  it('isValidRef accepts both forms, rejects malformed', () => {
    assert.equal(isValidRef('standup/job'), true);
    assert.equal(isValidRef('job'), true);
    assert.equal(isValidRef('a/b/c'), false);
    assert.equal(isValidRef('standup/has space'), false);
  });
});
