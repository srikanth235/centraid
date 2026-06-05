import { describe, expect, it } from 'vitest';
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
    expect(parseModelsJson(stdout)).toEqual([
      { id: 'openai-codex/gpt-5.5', name: 'gpt-5.5', default: true },
      { id: 'openai-codex/gpt-5.3-codex', name: 'gpt-5.3-codex' },
    ]);
  });

  it('returns [] for non-JSON output', () => {
    expect(parseModelsJson('not json')).toEqual([]);
  });

  it('returns [] when `models` is missing or not an array', () => {
    expect(parseModelsJson('{}')).toEqual([]);
    expect(parseModelsJson(JSON.stringify({ models: 'nope' }))).toEqual([]);
  });

  it('skips entries without a string `key`', () => {
    const stdout = JSON.stringify({
      models: [{ name: 'no key' }, { key: '' }, { key: 'a/b' }],
    });
    expect(parseModelsJson(stdout)).toEqual([{ id: 'a/b' }]);
  });

  it('omits `name` when absent and `default` when not tagged', () => {
    const stdout = JSON.stringify({ models: [{ key: 'x/y', tags: [] }] });
    expect(parseModelsJson(stdout)).toEqual([{ id: 'x/y' }]);
  });
});

describe('parseClassification', () => {
  const envelope = (text: string) => JSON.stringify({ ok: true, outputs: [{ text }] });

  it('maps the infer-run envelope to an id→tier record', () => {
    const stdout = envelope(
      '[{"id":"openai-codex/gpt-5.5","tier":"smart"},{"id":"openai/gpt-5.4-mini","tier":"fast"}]',
    );
    expect(parseClassification(stdout)).toEqual({
      'openai-codex/gpt-5.5': 'smart',
      'openai/gpt-5.4-mini': 'fast',
    });
  });

  it('strips ```json code fences', () => {
    const stdout = envelope('```json\n[{"id":"a/b","tier":"balanced"}]\n```');
    expect(parseClassification(stdout)).toEqual({ 'a/b': 'balanced' });
  });

  it('drops entries with an invalid tier or missing id', () => {
    const stdout = envelope(
      '[{"id":"a/b","tier":"genius"},{"tier":"fast"},{"id":"c/d","tier":"fast"}]',
    );
    expect(parseClassification(stdout)).toEqual({ 'c/d': 'fast' });
  });

  it('returns {} for a malformed envelope', () => {
    expect(parseClassification('not json')).toEqual({});
    expect(parseClassification(JSON.stringify({ outputs: [] }))).toEqual({});
    expect(parseClassification(envelope('not an array'))).toEqual({});
  });
});

describe('hashModelIds', () => {
  it('is stable regardless of order and changes with the id set', () => {
    const a = hashModelIds([{ id: 'x' }, { id: 'y' }]);
    const b = hashModelIds([{ id: 'y' }, { id: 'x' }]);
    const c = hashModelIds([{ id: 'x' }, { id: 'z' }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
