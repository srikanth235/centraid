import { expect, test } from 'vitest';
import { mergePersistedSettings } from './settings-merge.ts';

test('sets a runner model without disturbing other fields', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local' },
    { chatModelByRunner: { codex: 'gpt-5.5' } },
  );
  expect(next.chatModelByRunner).toEqual({ codex: 'gpt-5.5' });
  expect(next.activeGatewayId).toBe('local');
});

test('per-runner patch merges key-by-key — sibling runners are preserved', () => {
  const next = mergePersistedSettings(
    {
      activeGatewayId: 'local',
      chatModelByRunner: { codex: 'gpt-5.5', 'claude-code': 'claude-opus-4-8' },
    },
    { chatModelByRunner: { codex: 'gpt-5.4-mini' } },
  );
  expect(next.chatModelByRunner).toEqual({
    codex: 'gpt-5.4-mini',
    'claude-code': 'claude-opus-4-8',
  });
});

test('empty-string clears just that runner, leaving siblings intact', () => {
  const next = mergePersistedSettings(
    {
      activeGatewayId: 'local',
      chatModelByRunner: { codex: 'gpt-5.5', 'claude-code': 'claude-opus-4-8' },
    },
    { chatModelByRunner: { 'claude-code': '' } },
  );
  expect(next.chatModelByRunner).toEqual({ codex: 'gpt-5.5' });
});

test('clearing the last entry drops the field entirely', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', chatModelByRunner: { codex: 'gpt-5.5' } },
    { chatModelByRunner: { codex: '' } },
  );
  expect('chatModelByRunner' in next).toBe(false);
});

test('an omitted chatModelByRunner preserves the whole map', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', chatModelByRunner: { codex: 'gpt-5.5' } },
    { remoteTemplatesUrl: 'https://example.test/feed.json' },
  );
  expect(next.chatModelByRunner).toEqual({ codex: 'gpt-5.5' });
  expect(next.remoteTemplatesUrl).toBe('https://example.test/feed.json');
});

test('clearing one runner leaves other top-level fields intact', () => {
  const next = mergePersistedSettings(
    {
      activeGatewayId: 'local',
      chatModelByRunner: { codex: 'gpt-5.5', 'claude-code': 'claude-opus-4-8' },
      remoteTemplatesUrl: 'https://example.test/feed.json',
      onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
    },
    { chatModelByRunner: { codex: '' } },
  );
  expect(next.chatModelByRunner).toEqual({ 'claude-code': 'claude-opus-4-8' });
  expect(next.remoteTemplatesUrl).toBe('https://example.test/feed.json');
  expect(next.onboardingCompletedAt).toBe('2026-01-01T00:00:00.000Z');
  expect(next.activeGatewayId).toBe('local');
});

test('activeGatewayId falls back to current when patch omits/blanks it', () => {
  expect(mergePersistedSettings({ activeGatewayId: 'local' }, {}).activeGatewayId).toBe('local');
  expect(
    mergePersistedSettings({ activeGatewayId: 'local' }, { activeGatewayId: '   ' })
      .activeGatewayId,
  ).toBe('local');
  expect(
    mergePersistedSettings({ activeGatewayId: 'local' }, { activeGatewayId: 'remote-1' })
      .activeGatewayId,
  ).toBe('remote-1');
});
