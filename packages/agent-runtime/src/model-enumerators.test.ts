import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mapClaudeModels } from './model-enumerators.ts';
import { parseModelList } from './codex-model-list.ts';

// ---- claude SDK `supportedModels()` mapping ----

test('claude: prefers description for name, falls back to displayName, flags default', () => {
  const infos = [
    {
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Opus 4.7 with 1M context · Most capable for complex work',
    },
    { value: 'sonnet', displayName: 'Sonnet' }, // no description → falls back to displayName
    { value: 'haiku' }, // neither → no name
  ];
  assert.deepEqual(mapClaudeModels(infos), [
    {
      id: 'default',
      name: 'Opus 4.7 with 1M context · Most capable for complex work',
      default: true,
    },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku' },
  ]);
});

test('claude: drops name when it equals the id', () => {
  assert.deepEqual(mapClaudeModels([{ value: 'sonnet', description: 'sonnet' }]), [
    { id: 'sonnet' },
  ]);
});

test('claude: dedupes by id and skips entries with no usable id', () => {
  const infos = [
    { value: 'sonnet', description: 'Sonnet 4.6' },
    { value: 'sonnet', description: 'dupe' },
    { value: '  ' },
    { value: 42 },
    {},
  ];
  assert.deepEqual(
    mapClaudeModels(infos).map((m) => m.id),
    ['sonnet'],
  );
});

test('claude: empty input → []', () => {
  assert.deepEqual(mapClaudeModels([]), []);
});

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
