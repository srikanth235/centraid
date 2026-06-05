import { expect, test } from 'vitest';
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
  expect(mapClaudeModels(infos)).toEqual([
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
  expect(mapClaudeModels([{ value: 'sonnet', description: 'sonnet' }])).toEqual([{ id: 'sonnet' }]);
});

test('claude: dedupes by id and skips entries with no usable id', () => {
  const infos = [
    { value: 'sonnet', description: 'Sonnet 4.6' },
    { value: 'sonnet', description: 'dupe' },
    { value: '  ' },
    { value: 42 },
    {},
  ];
  expect(mapClaudeModels(infos).map((m) => m.id)).toEqual(['sonnet']);
});

test('claude: empty input → []', () => {
  expect(mapClaudeModels([])).toEqual([]);
});
