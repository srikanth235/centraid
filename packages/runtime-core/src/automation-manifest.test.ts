import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutomationManifestError,
  isValidAutomationName,
  isValidCronExpression,
  isValidActionFilename,
  parseManifest,
  validateManifest,
  validateOutputAgainstSchema,
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

describe('manifest trigger / back-compat (issue #80)', () => {
  const base = {
    prompt: 'hi',
    action: 'h.js',
    requires: {},
    generated: { by: 'test', at: '2026-05-19T00:00:00Z' },
  };

  it('normalizes legacy `schedule` into trigger.cron with the same expr', () => {
    const m = validateManifest({ ...base, schedule: '0 9 * * MON-FRI' });
    assert.equal(m.schedule, '0 9 * * MON-FRI');
    assert.equal(m.trigger.kind, 'cron');
    assert.equal(m.trigger.expr, '0 9 * * MON-FRI');
  });

  it('accepts new canonical trigger:{kind:cron,expr} form', () => {
    const m = validateManifest({
      ...base,
      trigger: { kind: 'cron', expr: '*/15 * * * *' },
    });
    assert.equal(m.trigger.kind, 'cron');
    assert.equal(m.trigger.expr, '*/15 * * * *');
    // `schedule` mirrors trigger.expr so existing consumers (mirror table,
    // cron registration) keep working with no change.
    assert.equal(m.schedule, '*/15 * * * *');
  });

  it('rejects unknown trigger.kind', () => {
    assert.throws(
      () => validateManifest({ ...base, trigger: { kind: 'webhook', expr: 'POST /x' } }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_trigger',
    );
  });

  it('rejects invalid trigger.expr cron', () => {
    assert.throws(
      () => validateManifest({ ...base, trigger: { kind: 'cron', expr: '@hourly' } }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_schedule',
    );
  });

  it('rejects manifest with neither schedule nor trigger', () => {
    assert.throws(() => validateManifest({ ...base }), /schedule/);
  });

  it('prefers trigger when both fields are present', () => {
    const m = validateManifest({
      ...base,
      schedule: '0 0 * * *',
      trigger: { kind: 'cron', expr: '*/5 * * * *' },
    });
    assert.equal(m.schedule, '*/5 * * * *');
    assert.equal(m.trigger.expr, '*/5 * * * *');
  });
});

describe('manifest outputSchema (issue #80)', () => {
  const base = {
    prompt: 'hi',
    schedule: '0 * * * *',
    action: 'h.js',
    requires: {},
    generated: { by: 'test', at: '2026-05-19T00:00:00Z' },
  };

  it('accepts a well-formed outputSchema', () => {
    const m = validateManifest({
      ...base,
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' }, count: { type: 'number' } },
        required: ['summary'],
      },
    });
    assert.equal(m.outputSchema?.type, 'object');
    assert.equal(m.outputSchema?.properties?.summary?.type, 'string');
    assert.deepEqual([...(m.outputSchema?.required ?? [])], ['summary']);
  });

  it('rejects non-object schema type', () => {
    assert.throws(
      () => validateManifest({ ...base, outputSchema: { type: 'string' } }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_output_schema',
    );
  });

  it('rejects properties with unknown types', () => {
    assert.throws(
      () =>
        validateManifest({
          ...base,
          outputSchema: { type: 'object', properties: { x: { type: 'datetime' } } },
        }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_output_schema',
    );
  });

  it('validateOutputAgainstSchema rejects missing required keys', () => {
    const schema = {
      type: 'object',
      properties: { summary: { type: 'string' } },
      required: ['summary'],
    } as const;
    assert.equal(validateOutputAgainstSchema(schema, { summary: 'ok' }), null);
    const err = validateOutputAgainstSchema(schema, { other: 'x' });
    assert.match(err ?? '', /missing required output property "summary"/);
  });

  it('validateOutputAgainstSchema rejects wrong property type', () => {
    const schema = {
      type: 'object',
      properties: { count: { type: 'number' } },
    } as const;
    const err = validateOutputAgainstSchema(schema, { count: 'not a number' });
    assert.match(err ?? '', /expected type number, got string/);
  });

  it('validateOutputAgainstSchema rejects non-object outputs', () => {
    const schema = { type: 'object' } as const;
    assert.match(validateOutputAgainstSchema(schema, 'hello') ?? '', /not an object/);
    assert.match(validateOutputAgainstSchema(schema, null) ?? '', /not an object/);
    assert.match(validateOutputAgainstSchema(schema, [1, 2]) ?? '', /not an object/);
  });
});

describe('manifest onFailure (issue #80)', () => {
  const base = {
    prompt: 'hi',
    schedule: '0 * * * *',
    action: 'h.js',
    requires: {},
    generated: { by: 'test', at: '2026-05-19T00:00:00Z' },
  };

  it('accepts a valid follow-up name', () => {
    const m = validateManifest({ ...base, onFailure: 'digest-alert' });
    assert.equal(m.onFailure, 'digest-alert');
  });

  it('rejects an invalid follow-up name', () => {
    assert.throws(
      () => validateManifest({ ...base, onFailure: 'a/b' }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_on_failure',
    );
  });

  it('rejects an empty follow-up string', () => {
    assert.throws(
      () => validateManifest({ ...base, onFailure: '' }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_on_failure',
    );
  });
});

describe('manifest history.keep (issue #80)', () => {
  const base = {
    prompt: 'hi',
    schedule: '0 * * * *',
    action: 'h.js',
    requires: {},
    generated: { by: 'test', at: '2026-05-19T00:00:00Z' },
  };

  it('defaults to count: 100 when history is omitted', () => {
    const m = validateManifest(base);
    assert.deepEqual(m.history, { keep: { count: 100 } });
  });

  it('accepts {count: N}', () => {
    const m = validateManifest({ ...base, history: { keep: { count: 50 } } });
    assert.deepEqual(m.history.keep, { count: 50 });
  });

  it('accepts {days: N}', () => {
    const m = validateManifest({ ...base, history: { keep: { days: 7 } } });
    assert.deepEqual(m.history.keep, { days: 7 });
  });

  it('accepts "all" and "errors"', () => {
    assert.equal(validateManifest({ ...base, history: { keep: 'all' } }).history.keep, 'all');
    assert.equal(validateManifest({ ...base, history: { keep: 'errors' } }).history.keep, 'errors');
  });

  it('rejects malformed keep shapes', () => {
    assert.throws(
      () => validateManifest({ ...base, history: { keep: { count: -1 } } }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_history',
    );
    assert.throws(
      () => validateManifest({ ...base, history: { keep: { weeks: 4 } } }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_history',
    );
    assert.throws(
      () => validateManifest({ ...base, history: { keep: 'forever' } }),
      (err) => err instanceof AutomationManifestError && err.code === 'invalid_history',
    );
  });
});
