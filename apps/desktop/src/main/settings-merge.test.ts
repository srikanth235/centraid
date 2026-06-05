import { test } from 'vitest';
import { strict as assert } from 'node:assert';
import { mergePersistedSettings } from './settings-merge.ts';

test('sets a runner model without disturbing other fields', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local' },
    { chatModelByRunner: { codex: 'gpt-5.5' } },
  );
  assert.deepEqual(next.chatModelByRunner, { codex: 'gpt-5.5' });
  assert.equal(next.activeGatewayId, 'local');
});

test('per-runner patch merges key-by-key — sibling runners are preserved', () => {
  const next = mergePersistedSettings(
    {
      activeGatewayId: 'local',
      chatModelByRunner: { codex: 'gpt-5.5', 'claude-code': 'claude-opus-4-8' },
    },
    { chatModelByRunner: { codex: 'gpt-5.4-mini' } },
  );
  assert.deepEqual(next.chatModelByRunner, {
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
  assert.deepEqual(next.chatModelByRunner, { codex: 'gpt-5.5' });
});

test('clearing the last entry drops the field entirely', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', chatModelByRunner: { codex: 'gpt-5.5' } },
    { chatModelByRunner: { codex: '' } },
  );
  assert.equal('chatModelByRunner' in next, false);
});

test('an omitted chatModelByRunner preserves the whole map', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', chatModelByRunner: { codex: 'gpt-5.5' } },
    { remoteTemplatesUrl: 'https://example.test/feed.json' },
  );
  assert.deepEqual(next.chatModelByRunner, { codex: 'gpt-5.5' });
  assert.equal(next.remoteTemplatesUrl, 'https://example.test/feed.json');
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
  assert.deepEqual(next.chatModelByRunner, { 'claude-code': 'claude-opus-4-8' });
  assert.equal(next.remoteTemplatesUrl, 'https://example.test/feed.json');
  assert.equal(next.onboardingCompletedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(next.activeGatewayId, 'local');
});

test('activeGatewayId falls back to current when patch omits/blanks it', () => {
  assert.equal(mergePersistedSettings({ activeGatewayId: 'local' }, {}).activeGatewayId, 'local');
  assert.equal(
    mergePersistedSettings({ activeGatewayId: 'local' }, { activeGatewayId: '   ' })
      .activeGatewayId,
    'local',
  );
  assert.equal(
    mergePersistedSettings({ activeGatewayId: 'local' }, { activeGatewayId: 'remote-1' })
      .activeGatewayId,
    'remote-1',
  );
});
