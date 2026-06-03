import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseModelsJson } from './openclaw-models.js';

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
