import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mergePersistedSettings } from './settings-merge.ts';

test('empty-string chatModel clears a previously-pinned model', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', chatModel: 'claude-opus-4-8' },
    { chatModel: '' },
  );
  assert.equal('chatModel' in next, false);
});

test('non-empty chatModel sets the value', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local' },
    { chatModel: 'claude-sonnet-4-6' },
  );
  assert.equal(next.chatModel, 'claude-sonnet-4-6');
});

test('undefined chatModel preserves the current value', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', chatModel: 'gpt-5.5' },
    { remoteTemplatesUrl: 'https://example.test/feed.json' },
  );
  assert.equal(next.chatModel, 'gpt-5.5');
  assert.equal(next.remoteTemplatesUrl, 'https://example.test/feed.json');
});

test('clearing chatModel leaves other fields intact', () => {
  const next = mergePersistedSettings(
    {
      activeGatewayId: 'local',
      chatModel: 'gpt-5.5',
      remoteTemplatesUrl: 'https://example.test/feed.json',
      onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
    },
    { chatModel: '' },
  );
  assert.equal('chatModel' in next, false);
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
