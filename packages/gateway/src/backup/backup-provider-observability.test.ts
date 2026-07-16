import { expect, test } from 'vitest';
import {
  BackupProviderError,
  type BackupProvider,
  type ObjectStore,
  type ProviderCapabilities,
  type ProviderInventoryObject,
} from '@centraid/backup';
import {
  collectInventory,
  pushProviderPolicy,
  type ProviderPolicySyncState,
} from './backup-provider-observability.js';

const capabilities = (extra: ProviderCapabilities['capabilities']): ProviderCapabilities => ({
  protocol: ['centraid-storage-provider/1'],
  dataPlane: 's3',
  capabilities: ['backup', ...extra],
  maxCredentialTtlSeconds: 3600,
  purgeAuthTier: 'api-key',
  backup: {
    softDeleteWindowDays: 7,
    retention: { kind: 'none' },
    restoreCostClass: 'free-egress',
    objectLock: false,
    conditionalWrites: true,
  },
});

function listStore(
  keys: string[],
  sizeFor: (key: string) => number = (key) => key.length,
): ObjectStore {
  return {
    put: async () => undefined,
    get: async () => new Uint8Array(),
    getStream: async function* () {
      yield new Uint8Array();
    },
    head: async () => null,
    list: async function* () {
      for (const key of keys) yield { key, size: sizeFor(key), etagOrHash: key };
    },
    delete: async () => undefined,
  };
}

function provider(overrides: Partial<BackupProvider>): BackupProvider {
  return {
    capabilities: async () => capabilities([]),
    createTarget: async () => ({ targetId: 'target' }),
    deleteTarget: async () => undefined,
    undeleteTarget: async () => undefined,
    purgeTarget: async () => undefined,
    openDataPlane: async () => listStore([]),
    registerSnapshot: async () => {
      throw new Error('unused');
    },
    listSnapshots: async () => [],
    getSnapshot: async () => {
      throw new Error('unused');
    },
    getTarget: async () => {
      throw new Error('unused');
    },
    usage: async () => {
      throw new Error('unused');
    },
    ...overrides,
  };
}

const desired = {
  rpoSeconds: 60,
  snapshotIntervalHours: 24,
  verifyEveryDays: 7,
  casAck: 'receipt' as const,
};

test('policy push persists a typed provider rejection instead of flattening it', async () => {
  const result = await pushProviderPolicy({
    provider: provider({
      capabilities: async () => capabilities(['policy']),
      putPolicy: async () => {
        throw BackupProviderError.of('policy_unmet', 'replicated acknowledgement unavailable', {
          field: 'casAck',
        });
      },
    }),
    targetId: 'target',
    desired,
    checkedAt: '2026-07-16T00:00:00.000Z',
  });
  expect(result).toMatchObject<Partial<ProviderPolicySyncState>>({
    status: 'rejected',
    errorCode: 'policy_unmet',
    details: { field: 'casAck' },
  });
});

test('policy push grades a mismatched provider echo as drift', async () => {
  const result = await pushProviderPolicy({
    provider: provider({
      capabilities: async () => capabilities(['policy']),
      putPolicy: async (_target, policy) => ({
        ...policy,
        rpoSeconds: policy.rpoSeconds * 2,
        declaredAt: 1,
      }),
    }),
    targetId: 'target',
    desired,
    checkedAt: '2026-07-16T00:00:00.000Z',
  });
  expect(result.status).toBe('drift');
  expect(result.echo?.rpoSeconds).toBe(120);
});

test('verify-bucket inventory cross-check reports both directions of provider drift', async () => {
  const rows = (keys: string[]): ProviderInventoryObject[] =>
    keys.map((key) => ({
      key,
      sizeBytes: key.length,
      etagOrHash: key,
      storedAt: 1,
      state: 'live',
    }));
  const result = await collectInventory({
    provider: provider({
      capabilities: async () => capabilities(['inventory']),
      listInventory: async () => ({
        store: 'backup',
        objects: rows(['shared', 'provider-only']),
        nextCursor: null,
      }),
      openDataPlane: async () => listStore(['shared', 'bucket-only']),
    }),
    targetId: 'target',
    store: 'backup',
    verifyBucket: true,
  });
  expect(result.source).toBe('bucket');
  expect(result.crossCheck).toEqual({
    providerOnly: ['provider-only'],
    bucketOnly: ['bucket-only'],
    metadataMismatch: [],
  });
});

test('verify-bucket inventory rejects a same-key byte metadata mismatch', async () => {
  const result = await collectInventory({
    provider: provider({
      capabilities: async () => capabilities(['inventory']),
      listInventory: async () => ({
        store: 'cas',
        objects: [
          {
            key: 'blobs/sha256/value',
            sizeBytes: 99,
            etagOrHash: 'stale-etag',
            storedAt: 1,
            state: 'live',
          },
        ],
        nextCursor: null,
      }),
      openDataPlane: async () => listStore(['blobs/sha256/value']),
    }),
    targetId: 'target',
    store: 'cas',
    verifyBucket: true,
  });
  expect(result.crossCheck?.metadataMismatch).toEqual(['blobs/sha256/value']);
});

test('an advertised but failing inventory falls back to raw LIST with an honest label', async () => {
  const result = await collectInventory({
    provider: provider({
      capabilities: async () => capabilities(['inventory']),
      listInventory: async () => {
        throw new Error('attestation unavailable');
      },
      openDataPlane: async () => listStore(['chunks/a']),
    }),
    targetId: 'target',
    store: 'backup',
    verifyBucket: false,
  });
  expect(result.source).toBe('bucket');
  expect(result.providerAttested).toBe(false);
  expect(result.attestationError).toContain('unavailable');
  expect(result.objects.map((row) => row.key)).toEqual(['chunks/a']);
});
