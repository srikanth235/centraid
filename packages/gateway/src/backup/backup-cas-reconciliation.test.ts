import { afterEach, expect, test } from 'vitest';
import { bootstrapVault, openVaultDb, ReplicaIndex } from '@centraid/vault';
import { runCasOnlyReconciliation } from './backup-cas-reconciliation.js';

const opened: ReturnType<typeof openVaultDb>[] = [];
const CORRUPT = 'a'.repeat(64);

afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

function db(): ReturnType<typeof openVaultDb> {
  const value = openVaultDb();
  bootstrapVault(value, { vaultId: 'vault-a', ownerName: 'Priya' });
  opened.push(value);
  return value;
}

test('provider CAS-only audit demotes an authenticated same-key failure', async () => {
  const vault = db();
  const index = new ReplicaIndex(vault.vault);
  index.mark(CORRUPT, 10);

  const state = await runCasOnlyReconciliation({
    db: vault,
    verifyBucket: true,
    checkedAt: '2026-07-16T00:00:00.000Z',
    collect: async () => ({
      configured: true,
      collection: {
        source: 'provider',
        providerAttested: true,
        objects: [
          {
            key: `blobs/sha256/${CORRUPT}`,
            sizeBytes: 10,
            etagOrHash: CORRUPT,
            storedAt: 1,
            state: 'live',
          },
        ],
      },
      authenticatedFailures: [CORRUPT],
    }),
  });

  expect(state).toMatchObject({
    mode: 'bucket',
    status: 'error',
    backup: { configured: false, source: 'not-configured' },
    cas: { configured: true, source: 'provider', missing: { count: 1, sample: [CORRUPT] } },
  });
  expect(index.has(CORRUPT)).toBe(false);
});

test('BYO CAS-only audit can be healthy without a snapshot-backup target', async () => {
  const state = await runCasOnlyReconciliation({
    db: db(),
    verifyBucket: false,
    checkedAt: '2026-07-16T00:00:00.000Z',
    collect: async () => ({
      configured: true,
      collection: { source: 'bucket', providerAttested: false, objects: [] },
    }),
  });

  expect(state).toMatchObject({
    mode: 'scheduled',
    status: 'ok',
    backup: { configured: false, source: 'not-configured' },
    cas: { configured: true, source: 'bucket', missing: { count: 0 }, orphans: { count: 0 } },
  });
});
