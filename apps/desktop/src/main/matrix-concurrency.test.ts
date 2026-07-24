/**
 * Matrix cell desktop.concurrency (#535 coverable-today).
 * mergePersistedSettings is pure — concurrent patches on the same base do not share outputs.
 */
import { expect, test } from 'vitest';
import { mergePersistedSettings } from './settings-merge.ts';

test('parallel merges from one base keep per-call patch isolation', () => {
  const base = {
    activeGatewayId: 'local',
    activeVaultByGateway: { local: 'v-0' },
  };
  const results = Array.from({ length: 20 }, (_, i) =>
    mergePersistedSettings(base, {
      remoteTemplatesUrl: `https://example.test/${i}.json`,
      // Each call supplies its own vault map so results are not aliased.
      activeVaultByGateway: { local: `v-${i}` },
    }),
  );
  for (let i = 0; i < results.length; i += 1) {
    expect(results[i]!.remoteTemplatesUrl).toBe(`https://example.test/${i}.json`);
    expect(results[i]!.activeVaultByGateway).toEqual({ local: `v-${i}` });
  }
  // Top-level result objects are distinct; mutating one field does not rewrite siblings.
  results[0]!.remoteTemplatesUrl = 'MUTATED';
  for (let i = 1; i < results.length; i += 1) {
    expect(results[i]!.remoteTemplatesUrl).toBe(`https://example.test/${i}.json`);
  }
  expect(base.activeGatewayId).toBe('local');
});
