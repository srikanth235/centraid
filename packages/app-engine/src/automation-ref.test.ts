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
  it('accepts plain-slug app folder ids', () => {
    assert.equal(isValidAppId('crm'), true);
    assert.equal(isValidAppId('standup-bot'), true);
    assert.equal(isValidAppId('My_App-2'), true);
  });

  it('rejects dotted / path-unsafe / plugin-internal ids', () => {
    assert.equal(isValidAppId(''), false);
    assert.equal(isValidAppId('_internal'), false);
    assert.equal(isValidAppId('a/b'), false);
    assert.equal(isValidAppId('up..dir'), false);
    // Dots are no longer part of the grammar — the legacy `auto.` prefix
    // is gone; automation apps are marked by the manifest `kind` field.
    assert.equal(isValidAppId('auto.standup-bot'), false);
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
