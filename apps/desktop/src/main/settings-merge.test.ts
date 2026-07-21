import { expect, test } from 'vitest';
import { mergePersistedSettings } from './settings-merge.ts';

test('an unrelated save preserves other top-level fields intact', () => {
  const next = mergePersistedSettings(
    {
      activeGatewayId: 'local',
      remoteTemplatesUrl: 'https://example.test/feed.json',
      onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
    },
    { remoteTemplatesUrl: 'https://example.test/feed2.json' },
  );
  expect(next.remoteTemplatesUrl).toBe('https://example.test/feed2.json');
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
    { remoteTemplatesUrl: 'https://example.test/feed.json' },
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
    { remoteTemplatesUrl: 'https://example.test/feed.json' },
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

test('launchAtLogin preserve-or-sets like a plain boolean field (issue #351)', () => {
  // Unset everywhere → dropped, not persisted as a default.
  expect(mergePersistedSettings({ activeGatewayId: 'local' }, {}).launchAtLogin).toBeUndefined();

  // A patch sets it.
  expect(
    mergePersistedSettings({ activeGatewayId: 'local' }, { launchAtLogin: true }).launchAtLogin,
  ).toBe(true);

  // An unrelated save carries the current value through.
  expect(
    mergePersistedSettings(
      { activeGatewayId: 'local', launchAtLogin: true },
      { remoteTemplatesUrl: 'https://example.test/feed.json' },
    ).launchAtLogin,
  ).toBe(true);

  // A patch can flip it back off.
  expect(
    mergePersistedSettings(
      { activeGatewayId: 'local', launchAtLogin: true },
      { launchAtLogin: false },
    ).launchAtLogin,
  ).toBe(false);
});

test('builderEnabled survives unrelated settings saves and can be switched off', () => {
  expect(
    mergePersistedSettings(
      { activeGatewayId: 'local', builderEnabled: true },
      { remoteTemplatesUrl: 'https://example.test/feed.json' },
    ).builderEnabled,
  ).toBe(true);
  expect(
    mergePersistedSettings(
      { activeGatewayId: 'local', builderEnabled: true },
      { builderEnabled: false },
    ).builderEnabled,
  ).toBe(false);
});
