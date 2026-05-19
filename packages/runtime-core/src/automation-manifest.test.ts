import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutomationManifestError,
  isValidAutomationName,
  isValidCronExpression,
  isValidActionFilename,
  parseManifest,
  validateManifest,
} from './automation-manifest.js';

describe('isValidCronExpression', () => {
  it('accepts canonical 5-field expressions', () => {
    assert.equal(isValidCronExpression('*/30 * * * *'), true);
    assert.equal(isValidCronExpression('0 9 * * MON-FRI'), true);
    assert.equal(isValidCronExpression('15,45 * * * *'), true);
    assert.equal(isValidCronExpression('0 0 1 1 *'), true);
  });

  it('rejects empty / non-5-field / illegal-char expressions', () => {
    assert.equal(isValidCronExpression(''), false);
    assert.equal(isValidCronExpression('   '), false);
    assert.equal(isValidCronExpression('* * * *'), false);
    assert.equal(isValidCronExpression('* * * * * *'), false);
    assert.equal(isValidCronExpression('@hourly'), false);
    assert.equal(isValidCronExpression('rm -rf / * * * *'), false);
  });
});

describe('isValidActionFilename', () => {
  it('accepts simple .js basenames', () => {
    assert.equal(isValidActionFilename('summarize-prs.js'), true);
    assert.equal(isValidActionFilename('a.js'), true);
    assert.equal(isValidActionFilename('snake_case.js'), true);
  });

  it('rejects paths, traversals, non-js, empty base', () => {
    assert.equal(isValidActionFilename('foo/bar.js'), false);
    assert.equal(isValidActionFilename('../x.js'), false);
    assert.equal(isValidActionFilename('.js'), false);
    assert.equal(isValidActionFilename('x.mjs'), false);
    assert.equal(isValidActionFilename(''), false);
  });
});

describe('isValidAutomationName', () => {
  it('accepts identifier-style names', () => {
    assert.equal(isValidAutomationName('summarize-prs'), true);
    assert.equal(isValidAutomationName('a1_b2-c3'), true);
  });
  it('rejects names with separators or empty', () => {
    assert.equal(isValidAutomationName('a/b'), false);
    assert.equal(isValidAutomationName('a.b'), false);
    assert.equal(isValidAutomationName(''), false);
  });
});

const goodManifest = {
  prompt: 'every 30 min, summarize open PRs in foo/bar',
  schedule: '*/30 * * * *',
  action: 'summarize-prs.js',
  requires: {
    mcps: ['github'],
    tools: ['github.list_pull_requests'],
    model: 'anthropic/claude-3-5-sonnet',
  },
  costEstimate: { model: 'anthropic/claude-3-5-sonnet', tokensPerFire: 5000 },
  generated: { by: 'builder', at: '2026-05-19T10:00:00Z' },
};

describe('parseManifest / validateManifest', () => {
  it('round-trips a well-formed manifest', () => {
    const m = parseManifest(JSON.stringify(goodManifest));
    assert.equal(m.prompt, goodManifest.prompt);
    assert.equal(m.schedule, goodManifest.schedule);
    assert.equal(m.action, goodManifest.action);
    assert.deepEqual([...(m.requires.mcps ?? [])], ['github']);
    assert.deepEqual([...(m.requires.tools ?? [])], ['github.list_pull_requests']);
    assert.equal(m.requires.model, 'anthropic/claude-3-5-sonnet');
    assert.deepEqual(m.costEstimate, { model: 'anthropic/claude-3-5-sonnet', tokensPerFire: 5000 });
    assert.equal(m.generated.by, 'builder');
  });

  it('rejects invalid JSON', () => {
    assert.throws(() => parseManifest('not json'), AutomationManifestError);
    try {
      parseManifest('not json');
    } catch (err) {
      assert.equal((err as AutomationManifestError).code, 'invalid_json');
    }
  });

  it('rejects missing required fields', () => {
    const noPrompt = { ...goodManifest } as Record<string, unknown>;
    delete noPrompt.prompt;
    assert.throws(() => validateManifest(noPrompt), /prompt/);

    const noSched = { ...goodManifest } as Record<string, unknown>;
    delete noSched.schedule;
    assert.throws(() => validateManifest(noSched), /schedule/);

    const noGenerated = { ...goodManifest } as Record<string, unknown>;
    delete noGenerated.generated;
    assert.throws(() => validateManifest(noGenerated), /generated/);
  });

  it('rejects bad cron expressions', () => {
    assert.throws(() => validateManifest({ ...goodManifest, schedule: '@hourly' }), /schedule/);
  });

  it('rejects action path traversal', () => {
    assert.throws(() => validateManifest({ ...goodManifest, action: '../evil.js' }), /action/);
    assert.throws(() => validateManifest({ ...goodManifest, action: 'sub/a.js' }), /action/);
  });

  it('rejects requires.model targeting centraid-mock (recursion guard)', () => {
    const bad = {
      ...goodManifest,
      requires: { ...goodManifest.requires, model: 'centraid-mock/run-automation' },
    };
    try {
      validateManifest(bad);
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof AutomationManifestError);
      assert.equal((err as AutomationManifestError).code, 'mock_model_disallowed');
    }
  });

  it('rejects negative tokensPerFire', () => {
    const bad = { ...goodManifest, costEstimate: { model: 'x/y', tokensPerFire: -1 } };
    assert.throws(() => validateManifest(bad), /tokensPerFire/);
  });

  it('allows omitting optional fields', () => {
    const minimal = {
      prompt: 'hello',
      schedule: '0 * * * *',
      action: 'h.js',
      requires: {},
      generated: { by: 'test', at: '2026-01-01T00:00:00Z' },
    };
    const m = validateManifest(minimal);
    assert.equal(m.requires.mcps, undefined);
    assert.equal(m.costEstimate, undefined);
  });
});
