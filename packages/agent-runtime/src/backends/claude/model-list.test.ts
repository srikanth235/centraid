import { test } from 'vitest';
import { strict as assert } from 'node:assert';
import { mapClaudeModels } from './model-list.ts';

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
