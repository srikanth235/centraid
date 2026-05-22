import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAutomationRef,
  isValidAppId,
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

describe('isValidAppId', () => {
  it('accepts app folder ids including the auto. prefix', () => {
    assert.equal(isValidAppId('crm'), true);
    assert.equal(isValidAppId('auto.standup-bot'), true);
    assert.equal(isValidAppId('My_App-2'), true);
  });

  it('rejects path-unsafe / plugin-internal ids', () => {
    assert.equal(isValidAppId(''), false);
    assert.equal(isValidAppId('_internal'), false);
    assert.equal(isValidAppId('a/b'), false);
    assert.equal(isValidAppId('up..dir'), false);
  });
});

describe('automation refs', () => {
  it('formats and parses the canonical <appId>/<id> handle', () => {
    assert.equal(formatAutomationRef('auto.standup-bot', 'job'), 'auto.standup-bot/job');
    assert.deepEqual(parseAutomationRef('auto.standup-bot/job'), {
      appId: 'auto.standup-bot',
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
    assert.equal(isValidAutomationRef('auto.x/job'), true);
    assert.equal(isValidAutomationRef('job'), true);
    assert.equal(isValidAutomationRef('a/b/c'), false);
    assert.equal(isValidAutomationRef('auto.x/has space'), false);
  });
});
