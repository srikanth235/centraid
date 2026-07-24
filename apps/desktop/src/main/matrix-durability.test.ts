/**
 * Matrix cell desktop.durability (#535 coverable-today).
 * Multi-step patches must not lose vault map / onboarding markers.
 */
import { expect, test } from 'vitest';
import { mergePersistedSettings } from './settings-merge.ts';

test('sequential merges keep activeVaultByGateway across unrelated patches', () => {
  let state = mergePersistedSettings(
    { activeGatewayId: 'local' },
    { activeVaultByGateway: { local: 'v-1', remote: 'v-9' } },
  );
  state = mergePersistedSettings(state, { remoteTemplatesUrl: 'https://example.test/a.json' });
  state = mergePersistedSettings(state, { onboardingCompletedAt: '2026-07-01T00:00:00.000Z' });
  expect(state.activeVaultByGateway).toEqual({ local: 'v-1', remote: 'v-9' });
  expect(state.remoteTemplatesUrl).toBe('https://example.test/a.json');
  expect(state.onboardingCompletedAt).toBe('2026-07-01T00:00:00.000Z');
});

test('vault map can be intentionally replaced without wiping other durable fields', () => {
  const base = mergePersistedSettings(
    {
      activeGatewayId: 'local',
      onboardingCompletedAt: '2026-01-01T00:00:00.000Z',
      activeVaultByGateway: { local: 'v-1' },
    },
    {},
  );
  const next = mergePersistedSettings(base, { activeVaultByGateway: { local: 'v-2' } });
  expect(next.activeVaultByGateway).toEqual({ local: 'v-2' });
  expect(next.onboardingCompletedAt).toBe('2026-01-01T00:00:00.000Z');
});
