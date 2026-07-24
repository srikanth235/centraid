/**
 * Matrix cell desktop.contracts (#535 coverable-today).
 * Settings merge contract: omit preserves, set replaces, blanks fall back.
 */
import { expect, test } from 'vitest';
import { mergePersistedSettings } from './settings-merge.ts';

test('mergePersistedSettings contract: empty patch is a pure identity on known fields', () => {
  const current = {
    activeGatewayId: 'local',
    remoteTemplatesUrl: 'https://example.test/feed.json',
    onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
    activeVaultByGateway: { local: 'v-1' },
  };
  const next = mergePersistedSettings(current, {});
  expect(next.activeGatewayId).toBe('local');
  expect(next.remoteTemplatesUrl).toBe('https://example.test/feed.json');
  expect(next.onboardingCompletedAt).toBe('2026-01-01T00:00:00.000Z');
  expect(next.activeVaultByGateway).toEqual({ local: 'v-1' });
});

test('blank activeGatewayId never clears the current gateway id', () => {
  const next = mergePersistedSettings({ activeGatewayId: 'local' }, { activeGatewayId: '   ' });
  expect(next.activeGatewayId).toBe('local');
});
