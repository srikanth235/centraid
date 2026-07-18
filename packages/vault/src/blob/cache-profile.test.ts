import { expect, test } from 'vitest';
import { replicationConcurrencyFromEnv } from './cache.js';

test('replication defaults to one lane on constrained hosts and remains tunable', () => {
  const constrained = { cores: 4, totalMemoryBytes: 2 * 1024 ** 3 };
  const large = { cores: 8, totalMemoryBytes: 16 * 1024 ** 3 };
  expect(replicationConcurrencyFromEnv({}, constrained)).toBe(1);
  expect(replicationConcurrencyFromEnv({}, large)).toBe(3);
  expect(
    replicationConcurrencyFromEnv({ CENTRAID_REPLICATION_CONCURRENCY: '2' }, constrained),
  ).toBe(2);
});
