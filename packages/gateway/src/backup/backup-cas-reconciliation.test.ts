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

// ---------- issue #425 Wave 2: per-store reconciliation ----------

type CasCollect = NonNullable<Parameters<typeof runCasOnlyReconciliation>[0]['collect']>;

/** A single-object live provider collection for one store class. */
function liveObject(sha: string): {
  source: 'provider';
  providerAttested: true;
  objects: {
    key: string;
    sizeBytes: number;
    etagOrHash: string;
    storedAt: number;
    state: 'live';
  }[];
} {
  return {
    source: 'provider',
    providerAttested: true,
    objects: [
      { key: `blobs/sha256/${sha}`, sizeBytes: 1, etagOrHash: sha, storedAt: 1, state: 'live' },
    ],
  };
}

test('the cas diff never disproves derived evidence (and vice-versa)', async () => {
  const vault = db();
  const index = new ReplicaIndex(vault.vault);
  const casSha = '1'.repeat(64);
  const derivedSha = '2'.repeat(64);
  index.mark(casSha, 10, 'cas');
  index.mark(derivedSha, 20, 'derived');
  // Each store's listing carries ONLY its own object; the cas pass must not see
  // the derived sha as "missing", nor the derived pass the cas sha.
  const collect: CasCollect = async (opts) => ({
    configured: true,
    collection: liveObject(opts.store === 'derived' ? derivedSha : casSha),
  });

  await runCasOnlyReconciliation({
    db: vault,
    verifyBucket: false,
    checkedAt: '2099-01-01T00:00:00.000Z',
    collect,
  });

  expect(index.storeOf(casSha)).toBe('cas');
  expect(index.storeOf(derivedSha)).toBe('derived');
});

test('the derived store is diffed: a derived replica absent from the derived listing is demoted', async () => {
  const vault = db();
  const index = new ReplicaIndex(vault.vault);
  const derivedSha = '3'.repeat(64);
  index.mark(derivedSha, 20, 'derived');
  // cas listing healthy (empty); derived listing empty ⇒ the derived row is missing.
  const collect: CasCollect = async () => ({
    configured: true,
    collection: { source: 'provider', providerAttested: true, objects: [] },
  });

  const state = await runCasOnlyReconciliation({
    db: vault,
    verifyBucket: true,
    checkedAt: '2099-01-01T00:00:00.000Z',
    collect,
  });

  expect(index.has(derivedSha)).toBe(false);
  expect(state.cas.missing.count).toBeGreaterThanOrEqual(1);
  expect(state.cas.missing.sample).toContain(derivedSha);
  expect(state.status).toBe('error');
});
