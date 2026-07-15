import { describe, expect, test } from 'vitest';

import { replicaDatabaseName, replicaStorageKey } from './key.js';

describe('replica storage keys', () => {
  test('keys stable gateway identities and isolates every vault', async () => {
    const first = await replicaStorageKey({ gatewayId: 'gateway-one', vaultId: 'one' });
    const otherGateway = await replicaStorageKey({ gatewayId: 'gateway-two', vaultId: 'one' });
    const otherVault = await replicaStorageKey({
      gatewayId: 'gateway-one',
      vaultId: 'two',
    });
    expect(first).not.toBe(otherGateway);
    expect(first).not.toBe(otherVault);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    await expect(replicaDatabaseName({ gatewayId: 'gateway-one', vaultId: 'one' })).resolves.toBe(
      `/centraid-replica-${first}.sqlite3`,
    );
  });
});
