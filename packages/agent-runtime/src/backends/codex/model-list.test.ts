import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseModelList } from './model-list.ts';

// ---- codex `model/list` result parsing ----

test('codex: bare array of strings', () => {
  assert.deepEqual(
    parseModelList(['gpt-5.5-pro', 'gpt-5.5', 'gpt-5.5-mini']).map((m) => m.id),
    ['gpt-5.5-pro', 'gpt-5.5', 'gpt-5.5-mini'],
  );
});

test('codex: { models: [...] } with object entries', () => {
  const res = {
    models: [
      { id: 'gpt-5.5-pro', displayName: 'GPT-5.5 Pro' },
      { id: 'gpt-5.5', isDefault: true },
    ],
  };
  const models = parseModelList(res);
  assert.deepEqual(models[0], { id: 'gpt-5.5-pro', name: 'GPT-5.5 Pro' });
  assert.deepEqual(models[1], { id: 'gpt-5.5', default: true });
});

test('codex: { data: [...] } and id-ish fallbacks (model/slug)', () => {
  const res = { data: [{ model: 'gpt-5.5' }, { slug: 'o3' }, { name: 'gpt-5.5-mini' }] };
  assert.deepEqual(
    parseModelList(res).map((m) => m.id),
    ['gpt-5.5', 'o3', 'gpt-5.5-mini'],
  );
});

test('codex: envelope-level default id marks the entry', () => {
  const res = { default: 'gpt-5.5', models: ['gpt-5.5-pro', 'gpt-5.5'] };
  const models = parseModelList(res);
  assert.equal(models.find((m) => m.id === 'gpt-5.5')?.default, true);
  assert.equal(models.find((m) => m.id === 'gpt-5.5-pro')?.default, undefined);
});

test('codex: dedupes and drops entries with no usable id', () => {
  const res = { models: ['gpt-5.5', 'gpt-5.5', {}, { foo: 'bar' }, '  '] };
  assert.deepEqual(
    parseModelList(res).map((m) => m.id),
    ['gpt-5.5'],
  );
});

test('codex: garbage → []', () => {
  assert.deepEqual(parseModelList(null), []);
  assert.deepEqual(parseModelList('nope'), []);
  assert.deepEqual(parseModelList({ nothing: true }), []);
});
