import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseClaudeModelList } from './model-enumerators.ts';
import { parseModelList } from './codex-model-list.ts';

// ---- claude `-p` output parsing ----

test('claude: parses a raw JSON array', () => {
  const out = '["claude-opus-4-8","claude-sonnet-4-6","claude-haiku-4-5-20251001"]';
  assert.deepEqual(
    parseClaudeModelList(out).map((m) => m.id),
    ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
  );
});

test('claude: strips a ```json code fence', () => {
  const out = '```json\n["claude-opus-4-8", "claude-sonnet-4-6"]\n```';
  assert.deepEqual(
    parseClaudeModelList(out).map((m) => m.id),
    ['claude-opus-4-8', 'claude-sonnet-4-6'],
  );
});

test('claude: extracts the array out of surrounding prose', () => {
  const out = 'Sure! Here are the models:\n["claude-opus-4-8"]\nLet me know if you need more.';
  assert.deepEqual(
    parseClaudeModelList(out).map((m) => m.id),
    ['claude-opus-4-8'],
  );
});

test('claude: rejects non-claude ids and dedupes', () => {
  const out = '["claude-opus-4-8","gpt-5","claude-opus-4-8","",42]';
  assert.deepEqual(
    parseClaudeModelList(out).map((m) => m.id),
    ['claude-opus-4-8'],
  );
});

test('claude: empty / array-less garbage → []', () => {
  assert.deepEqual(parseClaudeModelList(''), []);
  assert.deepEqual(parseClaudeModelList('not json at all'), []);
  assert.deepEqual(parseClaudeModelList('{"foo":"bar"}'), []);
});

test('claude: leniently extracts an array embedded in an object wrapper', () => {
  // claude -p returns a bare array, but if it ever wraps it we still recover.
  assert.deepEqual(
    parseClaudeModelList('{"models":["claude-opus-4-8"]}').map((m) => m.id),
    ['claude-opus-4-8'],
  );
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
