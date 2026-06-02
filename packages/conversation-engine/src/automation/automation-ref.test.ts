import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAutomationRef,
  isValidAutomationId,
  isValidAutomationRef,
  parseAutomationRef,
} from './automation-ref.js';

describe('isValidAutomationId', () => {
  it('accepts filesystem-safe slugs', () => {
    assert.equal(isValidAutomationId('daily-digest'), true);
    assert.equal(isValidAutomationId('summarize_prs'), true);
    assert.equal(isValidAutomationId('Auto123'), true);
  });

  it('rejects empty / path-unsafe ids', () => {
    assert.equal(isValidAutomationId(''), false);
    assert.equal(isValidAutomationId('has space'), false);
    assert.equal(isValidAutomationId('../escape'), false);
    assert.equal(isValidAutomationId('dot.dot'), false);
  });
});

describe('automation refs', () => {
  it('formats and parses the canonical <appId>/<id> handle', () => {
    assert.equal(formatAutomationRef('standup-bot', 'job'), 'standup-bot/job');
    assert.deepEqual(parseAutomationRef('standup-bot/job'), {
      appId: 'standup-bot',
      automationId: 'job',
    });
  });

  it('resolves a bare id against withinApp', () => {
    assert.deepEqual(parseAutomationRef('sibling', 'crm'), {
      appId: 'crm',
      automationId: 'sibling',
    });
    assert.equal(parseAutomationRef('sibling'), undefined);
  });

  it('isValidAutomationRef accepts both forms, rejects malformed', () => {
    assert.equal(isValidAutomationRef('standup/job'), true);
    assert.equal(isValidAutomationRef('job'), true);
    assert.equal(isValidAutomationRef('a/b/c'), false);
    assert.equal(isValidAutomationRef('standup/has space'), false);
  });
});
