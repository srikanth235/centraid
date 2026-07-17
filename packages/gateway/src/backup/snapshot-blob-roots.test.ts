import { randomBytes } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  sealManifest,
  type BackupProvider,
  type Keyring,
  type ManifestEntry,
  type SnapshotRow,
} from '@centraid/backup';
import { blobShasFromManifestEntries, snapshotReferencedBlobShas } from './snapshot-blob-roots.js';

const VAULT_ID = 'vault-roots';

function keyring(): Keyring {
  return {
    version: 1,
    active: 1,
    epochs: [
      { epoch: 1, key: randomBytes(32).toString('base64'), createdAt: '2026-07-17T00:00:00.000Z' },
    ],
  };
}

function blobEntry(sha: string): ManifestEntry {
  // The content sha is the final path segment — mirrors the restore engine's parse.
  return {
    path: `blobs/sha256/${sha.slice(0, 2)}/${sha}`,
    kind: 'blob',
    size: 1,
    mtimeMs: 0,
    chunks: [],
  };
}

/**
 * A minimal in-memory provider that only implements the two methods the roots
 * helper touches: `listSnapshots` (unpruned) and `openDataPlane(...).get`.
 */
function fakeProvider(opts: {
  kr: Keyring;
  snapshots: { seq: number; entries: ManifestEntry[]; prunedAt?: number | null }[];
}): { provider: BackupProvider; unpruned: SnapshotRow[] } {
  const store = new Map<string, Uint8Array>();
  const unpruned: SnapshotRow[] = [];
  for (const snap of opts.snapshots) {
    const { bytes, manifestHash } = sealManifest({
      keyring: opts.kr,
      vaultId: VAULT_ID,
      keyEpoch: 1,
      generation: 1,
      prevManifestHash: null,
      chunkIndex: [],
      appMeta: {},
      entries: snap.entries,
    });
    const manifestKey = `manifests/${snap.seq}.json`;
    store.set(manifestKey, bytes);
    const row: SnapshotRow = {
      seq: snap.seq,
      manifestKey,
      manifestHash,
      prevManifestHash: null,
      totalBytes: 1,
      objectCount: 0,
      generation: 1,
      format: 'centraid-snapshot/2',
      appMeta: {},
      createdAt: snap.seq,
      prunedAt: snap.prunedAt ?? null,
    };
    if (row.prunedAt === null) unpruned.push(row);
  }
  const provider = {
    // Default listSnapshots returns only retained (unpruned) rows.
    listSnapshots: async (_targetId: string, listOpts?: { includePruned?: boolean }) =>
      listOpts?.includePruned ? unpruned : unpruned,
    openDataPlane: async () => ({
      get: async (key: string) => {
        const bytes = store.get(key);
        if (!bytes) throw new Error(`no object ${key}`);
        return bytes;
      },
    }),
  } as unknown as BackupProvider;
  return { provider, unpruned };
}

test('blobShasFromManifestEntries returns only blob entries, keyed by their content sha', () => {
  const blobSha = 'a'.repeat(64);
  const entries: ManifestEntry[] = [
    blobEntry(blobSha),
    { path: 'vault.db', kind: 'db', size: 10, mtimeMs: 0, chunks: [] },
    { path: 'journal.db', kind: 'db', size: 10, mtimeMs: 0, chunks: [] },
  ];
  expect(blobShasFromManifestEntries(entries)).toEqual([blobSha]);
});

test('a blob no longer live in the vault stays a retained-snapshot GC root', async () => {
  const kr = keyring();
  const retainedSha = 'b'.repeat(64);
  const { provider } = fakeProvider({
    kr,
    snapshots: [{ seq: 1, entries: [blobEntry(retainedSha)] }],
  });

  const roots = await snapshotReferencedBlobShas({
    provider,
    targetId: 't',
    keyring: kr,
    vaultId: VAULT_ID,
  });

  // The vault model no longer references retainedSha at all — the ONLY thing
  // keeping it live is the retained snapshot. It must be in the root set.
  expect(roots.has(retainedSha)).toBe(true);
});

test('the manifest-blob memo skips re-opening an already-seen manifest', async () => {
  const kr = keyring();
  const sha = 'c'.repeat(64);
  const { provider, unpruned } = fakeProvider({
    kr,
    snapshots: [{ seq: 1, entries: [blobEntry(sha)] }],
  });
  const cache = new Map<string, string[]>();

  await snapshotReferencedBlobShas({
    provider,
    targetId: 't',
    keyring: kr,
    vaultId: VAULT_ID,
    manifestBlobCache: cache,
  });
  expect(cache.get(unpruned[0]!.manifestHash)).toEqual([sha]);

  // Second run against a provider whose `get` would throw — proves the memo,
  // not a re-open, produced the result.
  const memoOnly = {
    listSnapshots: async () => unpruned,
    openDataPlane: async () => ({
      get: async () => {
        throw new Error('should not re-open a cached manifest');
      },
    }),
  } as unknown as BackupProvider;
  const roots = await snapshotReferencedBlobShas({
    provider: memoOnly,
    targetId: 't',
    keyring: kr,
    vaultId: VAULT_ID,
    manifestBlobCache: cache,
  });
  expect(roots.has(sha)).toBe(true);
});

test('an unreadable retained manifest FAILS the root computation (never shrinks it)', async () => {
  const kr = keyring();
  const provider = {
    listSnapshots: async (): Promise<SnapshotRow[]> => [
      {
        seq: 7,
        manifestKey: 'manifests/7.json',
        manifestHash: 'f'.repeat(64),
        prevManifestHash: null,
        totalBytes: 1,
        objectCount: 0,
        generation: 1,
        format: 'centraid-snapshot/2',
        appMeta: {},
        createdAt: 7,
        prunedAt: null,
      },
    ],
    openDataPlane: async () => ({
      get: async () => new TextEncoder().encode('not a manifest'),
    }),
  } as unknown as BackupProvider;

  await expect(
    snapshotReferencedBlobShas({ provider, targetId: 't', keyring: kr, vaultId: VAULT_ID }),
  ).rejects.toThrow(/cannot read manifest seq 7/);
});
