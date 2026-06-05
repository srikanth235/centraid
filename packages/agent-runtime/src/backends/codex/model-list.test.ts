import { expect, test } from 'vitest';
import { parseModelList } from './model-list.ts';

// ---- codex `model/list` result parsing ----

test('codex: bare array of strings', () => {
  expect(parseModelList(['gpt-5.5-pro', 'gpt-5.5', 'gpt-5.5-mini']).map((m) => m.id)).toEqual([
    'gpt-5.5-pro',
    'gpt-5.5',
    'gpt-5.5-mini',
  ]);
});

test('codex: { models: [...] } with object entries', () => {
  const res = {
    models: [
      { id: 'gpt-5.5-pro', displayName: 'GPT-5.5 Pro' },
      { id: 'gpt-5.5', isDefault: true },
    ],
  };
  const models = parseModelList(res);
  expect(models[0]).toEqual({ id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' });
  expect(models[1]).toEqual({ id: 'gpt-5.5', default: true });
});

test('codex: { data: [...] } and id-ish fallbacks (model/slug)', () => {
  const res = { data: [{ model: 'gpt-5.5' }, { slug: 'o3' }, { name: 'gpt-5.5-mini' }] };
  expect(parseModelList(res).map((m) => m.id)).toEqual(['gpt-5.5', 'o3', 'gpt-5.5-mini']);
});

test('codex: envelope-level default id marks the entry', () => {
  const res = { default: 'gpt-5.5', models: ['gpt-5.5-pro', 'gpt-5.5'] };
  const models = parseModelList(res);
  expect(models.find((m) => m.id === 'gpt-5.5')?.default).toBe(true);
  expect(models.find((m) => m.id === 'gpt-5.5-pro')?.default).toBe(undefined);
});

test('codex: dedupes and drops entries with no usable id', () => {
  const res = { models: ['gpt-5.5', 'gpt-5.5', {}, { foo: 'bar' }, '  '] };
  expect(parseModelList(res).map((m) => m.id)).toEqual(['gpt-5.5']);
});

test('codex: garbage → []', () => {
  expect(parseModelList(null)).toEqual([]);
  expect(parseModelList('nope')).toEqual([]);
  expect(parseModelList({ nothing: true })).toEqual([]);
});
