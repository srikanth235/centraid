import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsJson, parseClassification, hashModelIds } from './openclaw-models.js';

describe('parseModelsJson', () => {
  it('maps `openclaw models list --json` output to RunnerModel[]', () => {
    // Real shape from `openclaw models list --json`.
    const stdout = JSON.stringify({
      count: 2,
      models: [
        {
          key: 'openai-codex/gpt-5.5',
          name: 'gpt-5.5',
          contextWindow: 200000,
          local: false,
          available: true,
          tags: ['default', 'configured'],
          missing: false,
        },
        {
          key: 'openai-codex/gpt-5.3-codex',
          name: 'gpt-5.3-codex',
          tags: ['configured'],
        },
      ],
    });
    assert.deepEqual(parseModelsJson(stdout), [
      { id: 'openai-codex/gpt-5.5', name: 'gpt-5.5', default: true },
      { id: 'openai-codex/gpt-5.3-codex', name: 'gpt-5.3-codex' },
    ]);
  });

  it('returns [] for non-JSON output', () => {
    assert.deepEqual(parseModelsJson('not json'), []);
  });

  it('returns [] when `models` is missing or not an array', () => {
    assert.deepEqual(parseModelsJson('{}'), []);
    assert.deepEqual(parseModelsJson(JSON.stringify({ models: 'nope' })), []);
  });

  it('skips entries without a string `key`', () => {
    const stdout = JSON.stringify({
      models: [{ name: 'no key' }, { key: '' }, { key: 'a/b' }],
    });
    assert.deepEqual(parseModelsJson(stdout), [{ id: 'a/b' }]);
  });

  it('omits `name` when absent and `default` when not tagged', () => {
    const stdout = JSON.stringify({ models: [{ key: 'x/y', tags: [] }] });
    assert.deepEqual(parseModelsJson(stdout), [{ id: 'x/y' }]);
  });
});

describe('parseClassification', () => {
  const envelope = (text: string) => JSON.stringify({ ok: true, outputs: [{ text }] });

  it('maps the infer-run envelope to an id→tier record', () => {
    const stdout = envelope(
      '[{"id":"openai-codex/gpt-5.5","tier":"smart"},{"id":"openai/gpt-5.4-mini","tier":"fast"}]',
    );
    assert.deepEqual(parseClassification(stdout), {
      'openai-codex/gpt-5.5': 'smart',
      'openai/gpt-5.4-mini': 'fast',
    });
  });

  it('strips ```json code fences', () => {
    const stdout = envelope('```json\n[{"id":"a/b","tier":"balanced"}]\n```');
    assert.deepEqual(parseClassification(stdout), { 'a/b': 'balanced' });
  });

  it('drops entries with an invalid tier or missing id', () => {
    const stdout = envelope(
      '[{"id":"a/b","tier":"genius"},{"tier":"fast"},{"id":"c/d","tier":"fast"}]',
    );
    assert.deepEqual(parseClassification(stdout), { 'c/d': 'fast' });
  });

  it('returns {} for a malformed envelope', () => {
    assert.deepEqual(parseClassification('not json'), {});
    assert.deepEqual(parseClassification(JSON.stringify({ outputs: [] })), {});
    assert.deepEqual(parseClassification(envelope('not an array')), {});
  });
});

describe('hashModelIds', () => {
  it('is stable regardless of order and changes with the id set', () => {
    const a = hashModelIds([{ id: 'x' }, { id: 'y' }]);
    const b = hashModelIds([{ id: 'y' }, { id: 'x' }]);
    const c = hashModelIds([{ id: 'x' }, { id: 'z' }]);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});
