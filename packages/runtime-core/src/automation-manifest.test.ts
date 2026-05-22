import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutomationManifestError,
  isPendingWebhookTrigger,
  isValidAutomationId,
  isValidCronExpression,
  parseManifest,
  validateManifest,
  type AutomationManifest,
} from './automation-manifest.js';

/** A minimal valid `automation.json` object. */
function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Daily digest',
    version: '0.1.0',
    enabled: true,
    prompt: 'Summarize my open PRs every morning',
    trigger: { kind: 'cron', expr: '0 9 * * *' },
    requires: {},
    history: { keep: { count: 50 } },
    generated: { by: 'centraid-builder', at: '2026-05-22T00:00:00Z' },
    ...over,
  };
}

describe('isValidCronExpression', () => {
  it('accepts canonical 5-field expressions', () => {
    assert.equal(isValidCronExpression('*/30 * * * *'), true);
    assert.equal(isValidCronExpression('0 9 * * MON-FRI'), true);
    assert.equal(isValidCronExpression('15,45 * * * *'), true);
  });

  it('rejects empty / non-5-field / illegal-char expressions', () => {
    assert.equal(isValidCronExpression(''), false);
    assert.equal(isValidCronExpression('* * * *'), false);
    assert.equal(isValidCronExpression('* * * * * *'), false);
    assert.equal(isValidCronExpression('@hourly'), false);
    assert.equal(isValidCronExpression('rm -rf / * * * *'), false);
  });
});

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

describe('validateManifest', () => {
  it('accepts a minimal valid manifest', () => {
    const m = validateManifest(baseManifest());
    assert.equal(m.name, 'Daily digest');
    assert.equal(m.version, '0.1.0');
    assert.equal(m.enabled, true);
    // Legacy single `trigger` is dual-read into the plural `triggers`.
    assert.equal(m.triggers.length, 1);
    assert.deepEqual(m.triggers[0], { kind: 'cron', expr: '0 9 * * *' });
  });

  it('reads a plural triggers list with multiple crons', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [
      { kind: 'cron', expr: '0 9 * * *' },
      { kind: 'cron', expr: '0 17 * * *' },
    ];
    const m = validateManifest(raw);
    assert.equal(m.triggers.length, 2);
  });

  it('accepts a webhook trigger with an id + secret hash', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [{ kind: 'webhook', id: 'abc123', secretHash: 'deadbeef' }];
    const m = validateManifest(raw);
    assert.equal(m.triggers[0]?.kind, 'webhook');
  });

  it('accepts a pending webhook trigger (un-provisioned)', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [{ kind: 'webhook', pending: true }];
    const m = validateManifest(raw);
    assert.equal(m.triggers[0]?.kind, 'webhook');
    assert.equal(isPendingWebhookTrigger(m.triggers[0]!), true);
  });

  it('rejects a webhook trigger that is neither provisioned nor pending', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [{ kind: 'webhook' }];
    assert.throws(() => validateManifest(raw), AutomationManifestError);
  });

  it('treats an empty triggers list as legal (manual fire only)', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [];
    assert.deepEqual(validateManifest(raw).triggers, []);
  });

  it('rejects more than one webhook trigger', () => {
    const raw = baseManifest();
    delete raw.trigger;
    raw.triggers = [
      { kind: 'webhook', id: 'a', secretHash: 'h1' },
      { kind: 'webhook', id: 'b', secretHash: 'h2' },
    ];
    assert.throws(() => validateManifest(raw), AutomationManifestError);
  });

  it('defaults version to 0.1.0 and enabled to true when absent', () => {
    const raw = baseManifest();
    delete raw.version;
    delete raw.enabled;
    const m = validateManifest(raw);
    assert.equal(m.version, '0.1.0');
    assert.equal(m.enabled, true);
  });

  it('treats a non-true enabled as disabled', () => {
    assert.equal(validateManifest(baseManifest({ enabled: false })).enabled, false);
  });

  it('carries the apps association list', () => {
    const m = validateManifest(baseManifest({ apps: ['todos', 'habits'] }));
    assert.deepEqual(m.apps, ['todos', 'habits']);
  });

  it('rejects a missing name', () => {
    const raw = baseManifest();
    delete raw.name;
    assert.throws(() => validateManifest(raw), AutomationManifestError);
  });

  it('rejects a missing prompt', () => {
    const raw = baseManifest();
    delete raw.prompt;
    assert.throws(() => validateManifest(raw), AutomationManifestError);
  });

  it('rejects a missing generated block', () => {
    const raw = baseManifest();
    delete raw.generated;
    assert.throws(() => validateManifest(raw), AutomationManifestError);
  });

  it('rejects an invalid trigger', () => {
    assert.throws(
      () => validateManifest(baseManifest({ trigger: { kind: 'webhook' } })),
      AutomationManifestError,
    );
    assert.throws(
      () => validateManifest(baseManifest({ trigger: { kind: 'cron', expr: 'nope' } })),
      AutomationManifestError,
    );
  });

  it('rejects apps that is not an array of non-empty strings', () => {
    assert.throws(() => validateManifest(baseManifest({ apps: 'todos' })), AutomationManifestError);
    assert.throws(() => validateManifest(baseManifest({ apps: [''] })), AutomationManifestError);
  });

  it('rejects a requires.model pointing at the mock provider', () => {
    assert.throws(
      () => validateManifest(baseManifest({ requires: { model: 'centraid-mock/run' } })),
      AutomationManifestError,
    );
  });

  it('defaults history.keep to {count:100} when history is absent', () => {
    const raw = baseManifest();
    delete raw.history;
    const m: AutomationManifest = validateManifest(raw);
    assert.deepEqual(m.history.keep, { count: 100 });
  });
});

describe('parseManifest', () => {
  it('round-trips a JSON string', () => {
    const m = parseManifest(JSON.stringify(baseManifest()));
    assert.equal(m.name, 'Daily digest');
  });

  it('rejects invalid JSON', () => {
    assert.throws(() => parseManifest('{not json'), AutomationManifestError);
  });
});
