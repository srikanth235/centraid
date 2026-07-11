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

test('activeVaultByGateway is carried through an unrelated save (issue #289)', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', activeVaultByGateway: { local: 'v-1', 'gw-2': 'v-9' } },
    { chatModelByRunner: { codex: 'gpt-5.5' } },
  );
  expect(next.activeVaultByGateway).toEqual({ local: 'v-1', 'gw-2': 'v-9' });
});

test('activeVaultByGateway is replaced wholesale when the patch sets it', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', activeVaultByGateway: { local: 'v-1' } },
    { activeVaultByGateway: { local: 'v-2', 'gw-2': 'v-9' } },
  );
  expect(next.activeVaultByGateway).toEqual({ local: 'v-2', 'gw-2': 'v-9' });
});

test('an emptied vault map is dropped, not persisted empty', () => {
  const next = mergePersistedSettings(
    { activeGatewayId: 'local', activeVaultByGateway: { local: 'v-1' } },
    { activeVaultByGateway: {} },
  );
  expect(next.activeVaultByGateway).toBeUndefined();
});

test('gateway alert fields preserve-or-set, clamping the threshold on write', () => {
  // Unrelated save carries both fields through.
  const carried = mergePersistedSettings(
    { activeGatewayId: 'local', gatewayAlertSeconds: 300, gatewayAlertsEnabled: false },
    { chatModelByRunner: { codex: 'gpt-5.5' } },
  );
  expect(carried.gatewayAlertSeconds).toBe(300);
  expect(carried.gatewayAlertsEnabled).toBe(false);

  // A patch sets them; out-of-range thresholds clamp to [15, 3600].
  const set = mergePersistedSettings(
    { activeGatewayId: 'local' },
    { gatewayAlertSeconds: 5, gatewayAlertsEnabled: true },
  );
  expect(set.gatewayAlertSeconds).toBe(15);
  expect(set.gatewayAlertsEnabled).toBe(true);
  expect(
    mergePersistedSettings({ activeGatewayId: 'local' }, { gatewayAlertSeconds: 99_999 })
      .gatewayAlertSeconds,
  ).toBe(3600);

  // A garbage threshold falls back to the current value.
  const garbage = mergePersistedSettings(
    { activeGatewayId: 'local', gatewayAlertSeconds: 120 },
    { gatewayAlertSeconds: Number.NaN },
  );
  expect(garbage.gatewayAlertSeconds).toBe(120);

  // Absent everywhere → the fields are dropped, not persisted as defaults.
  const absent = mergePersistedSettings({ activeGatewayId: 'local' }, {});
  expect(absent.gatewayAlertSeconds).toBeUndefined();
  expect(absent.gatewayAlertsEnabled).toBeUndefined();
});
