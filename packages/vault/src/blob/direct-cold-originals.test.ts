// Direct-to-IA storage class for large media originals (issue #425 Wave 3
// Part B). The pure eligibility resolver + the local-first replication doors it
// wires into, which resolve the class from the sha's already-written
// `blob_staging` original row: the outbox-drain single PUT and the outbox-drain
// durable multipart CreateMultipartUpload (>32 MiB).
// Binary derivatives, small originals, non-media originals, and undeclared
// targets stay class-less; an explicit vault-level class suppresses the
// heuristic entirely.
// The remote-primary ingress doors — the low-level S3 CopyObject unit and the
// gateway-mediated multipart stream-through — live in direct-cold-doors.test.ts.

import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_BACKUP_POLICY, resolveBackupPolicy, type BackupPolicy } from '../backup-policy.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { BlobCache } from './cache.js';
import type { RemoteTier } from './custody-types.js';
import { FsBlobStore } from './local.js';
import { drainOutboxRow } from './outbox-drain.js';
import type { RemoteBlobTransfer } from './remote-transfer.js';
import type { BlobRange, BlobStore } from './store.js';
import { sha256OfBytes } from './store.js';
import {
  originalMediaForSha,
  resolveStorageClassForWrite,
  storageClassForShaWrite,
} from './store-routing.js';
import { BlobTransferState } from './transfer-state.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const SUPPORTED = ['STANDARD', 'STANDARD_IA'];

function rangeOf(bytes: Buffer, range?: BlobRange): Buffer {
  if (!range) return Buffer.from(bytes);
  return Buffer.from(bytes.subarray(range.start, (range.end ?? bytes.length - 1) + 1));
}

// ---------- the pure resolver ----------

const BIG = 30 * 1024 * 1024;

test('resolveStorageClassForWrite: the eligibility matrix', () => {
  const base = {
    desiredStore: 'cas' as const,
    policy: DEFAULT_BACKUP_POLICY,
    supportedStorageClasses: SUPPORTED,
  };
  // Eligible: video/audio original at/above the 25 MiB floor on a declaring target.
  expect(resolveStorageClassForWrite({ ...base, mediaType: 'video/mp4', byteSize: BIG })).toBe(
    'STANDARD_IA',
  );
  expect(resolveStorageClassForWrite({ ...base, mediaType: 'audio/mpeg', byteSize: BIG })).toBe(
    'STANDARD_IA',
  );
  // Not media (image is conservatively warm in v0).
  expect(
    resolveStorageClassForWrite({ ...base, mediaType: 'image/png', byteSize: BIG }),
  ).toBeUndefined();
  // Below the floor.
  expect(
    resolveStorageClassForWrite({ ...base, mediaType: 'video/mp4', byteSize: 10 * 1024 * 1024 }),
  ).toBeUndefined();
  // Target does not declare STANDARD_IA / declares nothing.
  expect(
    resolveStorageClassForWrite({
      ...base,
      supportedStorageClasses: ['STANDARD'],
      mediaType: 'video/mp4',
      byteSize: BIG,
    }),
  ).toBeUndefined();
  expect(
    resolveStorageClassForWrite({
      desiredStore: 'cas',
      policy: DEFAULT_BACKUP_POLICY,
      mediaType: 'video/mp4',
      byteSize: BIG,
    }),
  ).toBeUndefined();
  // A derived write is never demoted to cold.
  expect(
    resolveStorageClassForWrite({
      ...base,
      desiredStore: 'derived',
      mediaType: 'video/mp4',
      byteSize: BIG,
    }),
  ).toBeUndefined();
  // Not an original (no media/size known).
  expect(resolveStorageClassForWrite({ ...base })).toBeUndefined();
  // Explicit vault-level class wins — the heuristic stands down.
  expect(
    resolveStorageClassForWrite({
      ...base,
      policy: resolveBackupPolicy({ storageClass: 'DEEP_ARCHIVE' }),
      mediaType: 'video/mp4',
      byteSize: BIG,
    }),
  ).toBeUndefined();
  // Explicitly disabled.
  expect(
    resolveStorageClassForWrite({
      ...base,
      policy: resolveBackupPolicy({ directToColdOriginals: { enabled: false } }),
      mediaType: 'video/mp4',
      byteSize: BIG,
    }),
  ).toBeUndefined();
  // Custom knobs: a smaller floor + an image prefix opt-in.
  expect(
    resolveStorageClassForWrite({
      ...base,
      policy: resolveBackupPolicy({ directToColdOriginals: { minBytes: 1024 } }),
      mediaType: 'video/mp4',
      byteSize: 2048,
    }),
  ).toBe('STANDARD_IA');
  expect(
    resolveStorageClassForWrite({
      ...base,
      policy: resolveBackupPolicy({ directToColdOriginals: { mimePrefixes: ['image/'] } }),
      mediaType: 'image/png',
      byteSize: BIG,
    }),
  ).toBe('STANDARD_IA');
});

test('originalMediaForSha resolves originals and ignores derivatives', () => {
  const db = openVaultDb();
  cleanups.push(() => db.close());
  const originalSha = 'a'.repeat(64);
  const derivativeSha = 'b'.repeat(64);
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO blob_staging (staging_id, sha256, media_type, byte_size, variant, variant_of, staged_at)
       VALUES (?, ?, 'video/mp4', ?, NULL, NULL, ?)`,
    )
    .run('s-orig', originalSha, BIG, now);
  db.vault
    .prepare(
      `INSERT INTO blob_staging (staging_id, sha256, media_type, byte_size, variant, variant_of, staged_at)
       VALUES (?, ?, 'image/png', ?, 'thumb', ?, ?)`,
    )
    .run('s-thumb', derivativeSha, 4096, originalSha, now);
  expect(originalMediaForSha(db.vault, originalSha)).toEqual({
    mediaType: 'video/mp4',
    byteSize: BIG,
  });
  expect(originalMediaForSha(db.vault, derivativeSha)).toBeNull();
  expect(originalMediaForSha(db.vault, 'c'.repeat(64))).toBeNull();
});

// ---------- the outbox-drain doors ----------

interface DrainHarness {
  db: VaultDb;
  local: FsBlobStore;
  cache: BlobCache;
  state: BlobTransferState;
}

function openDrainHarness(): DrainHarness {
  const dir = mkdtempSync(path.join(tmpdir(), 'blob-cold-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openVaultDb({ dir });
  cleanups.push(() => db.close());
  db.blobTransfers.abandon();
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const cache = new BlobCache(db.vault, local, {
    qosCooldownMs: 0,
    settings: () => ({ budgetBytes: Number.MAX_SAFE_INTEGER }),
  });
  const state = new BlobTransferState(db.vault);
  return { db, local, cache, state };
}

/** Stage an ORIGINAL (variant IS NULL) with a media type + enqueue its bytes. */
function stageOriginal(h: DrainHarness, bytes: Buffer, mediaType: string): string {
  const sha = sha256OfBytes(bytes);
  h.local.putSync(sha, bytes);
  h.state.enqueue(sha, bytes.length);
  h.db.vault
    .prepare(
      `INSERT INTO blob_staging (staging_id, sha256, media_type, byte_size, variant, variant_of, staged_at)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
    )
    .run(`stage-${sha.slice(0, 12)}`, sha, mediaType, bytes.length, new Date().toISOString());
  return sha;
}

function storageClassFor(
  h: DrainHarness,
  supported: readonly string[] | undefined,
  policy: BackupPolicy,
): (sha: string, storeClass: 'cas' | 'derived') => string | undefined {
  return (sha, storeClass) =>
    storageClassForShaWrite(h.db.vault, sha, storeClass, supported, policy);
}

/** A single-PUT cas store (no putStream) that records the class per write. */
function putCaptureStore(): { store: BlobStore; classOf: Map<string, string | undefined> } {
  const objects = new Map<string, Buffer>();
  const classOf = new Map<string, string | undefined>();
  const store: BlobStore = {
    kind: 'put-capture',
    put: async (sha, bytes, storageClass) => {
      objects.set(sha, Buffer.from(bytes));
      classOf.set(sha, storageClass);
    },
    get: async (sha, range) => {
      const bytes = objects.get(sha);
      return bytes ? rangeOf(bytes, range) : null;
    },
    has: async (sha) => objects.has(sha),
    delete: async (sha) => void objects.delete(sha),
    list: async () => [...objects.keys()],
    stat: async (sha) => {
      const bytes = objects.get(sha);
      return bytes ? { size: bytes.length } : null;
    },
  };
  return { store, classOf };
}

test('outbox drain single-PUT door: a >floor video original PUTs STANDARD_IA', async () => {
  const h = openDrainHarness();
  const policy = resolveBackupPolicy({ directToColdOriginals: { minBytes: 1024 } });
  const sha = stageOriginal(h, randomBytes(4096), 'video/mp4');
  const { store, classOf } = putCaptureStore();
  const remote: RemoteTier = {
    store,
    storageClassFor: storageClassFor(h, SUPPORTED, policy),
  };
  await drainOutboxRow(
    {
      state: h.state,
      local: h.local,
      cache: h.cache,
      remote: () => remote,
      onReplicated: () => undefined,
    },
    h.state.outbox(sha)!,
  );
  expect(h.state.outbox(sha)).toBeNull();
  expect(classOf.get(sha)).toBe('STANDARD_IA');
});

test('outbox drain single-PUT door: small / non-media / undeclared stay class-less', async () => {
  const policy = resolveBackupPolicy({ directToColdOriginals: { minBytes: 1024 } });
  // A tiny original (below the floor).
  {
    const h = openDrainHarness();
    const sha = stageOriginal(h, randomBytes(512), 'video/mp4');
    const { store, classOf } = putCaptureStore();
    await drainOutboxRow(
      {
        state: h.state,
        local: h.local,
        cache: h.cache,
        remote: () => ({ store, storageClassFor: storageClassFor(h, SUPPORTED, policy) }),
        onReplicated: () => undefined,
      },
      h.state.outbox(sha)!,
    );
    expect(classOf.get(sha)).toBeUndefined();
  }
  // A non-media original at size.
  {
    const h = openDrainHarness();
    const sha = stageOriginal(h, randomBytes(4096), 'application/pdf');
    const { store, classOf } = putCaptureStore();
    await drainOutboxRow(
      {
        state: h.state,
        local: h.local,
        cache: h.cache,
        remote: () => ({ store, storageClassFor: storageClassFor(h, SUPPORTED, policy) }),
        onReplicated: () => undefined,
      },
      h.state.outbox(sha)!,
    );
    expect(classOf.get(sha)).toBeUndefined();
  }
  // A large video original against a target that declares NO classes.
  {
    const h = openDrainHarness();
    const sha = stageOriginal(h, randomBytes(4096), 'video/mp4');
    const { store, classOf } = putCaptureStore();
    await drainOutboxRow(
      {
        state: h.state,
        local: h.local,
        cache: h.cache,
        remote: () => ({ store, storageClassFor: storageClassFor(h, undefined, policy) }),
        onReplicated: () => undefined,
      },
      h.state.outbox(sha)!,
    );
    expect(classOf.get(sha)).toBeUndefined();
  }
});

test('outbox drain single-PUT door: a binary derivative never goes to cold', async () => {
  const h = openDrainHarness();
  const policy = resolveBackupPolicy({ directToColdOriginals: { minBytes: 1024 } });
  const bytes = randomBytes(4096);
  const sha = sha256OfBytes(bytes);
  h.local.putSync(sha, bytes);
  h.state.enqueue(sha, bytes.length);
  // Record the sha as a binary derivative — NOT an original.
  h.db.vault
    .prepare(
      `INSERT INTO blob_staging (staging_id, sha256, media_type, byte_size, variant, variant_of, staged_at)
       VALUES (?, ?, 'video/mp4', ?, 'poster', ?, ?)`,
    )
    .run('stage-poster', sha, bytes.length, '0'.repeat(64), new Date().toISOString());
  const { store, classOf } = putCaptureStore();
  await drainOutboxRow(
    {
      state: h.state,
      local: h.local,
      cache: h.cache,
      remote: () => ({ store, storageClassFor: storageClassFor(h, SUPPORTED, policy) }),
      onReplicated: () => undefined,
    },
    h.state.outbox(sha)!,
  );
  expect(classOf.get(sha)).toBeUndefined();
});

test('outbox drain multipart door: a >32 MiB video original CreateMultipartUpload carries STANDARD_IA', async () => {
  const h = openDrainHarness();
  const plain = randomBytes(33 * 1024 * 1024);
  expect(DEFAULT_BACKUP_POLICY.outboxBudgetBytes).toBeGreaterThan(plain.length);
  const sha = stageOriginal(h, plain, 'video/mp4');

  const final = new Map<string, Buffer>();
  const uploaded = new Map<number, Buffer>();
  let createClass: string | undefined = 'unset';
  const transfer: RemoteBlobTransfer = {
    beginShaUpload: async (targetSha, storageClass) => {
      expect(targetSha).toBe(sha);
      createClass = storageClass;
      return 'upload-1';
    },
    uploadShaPart: async (_sha, _uploadId, partNumber, bytes) => {
      uploaded.set(partNumber, Buffer.from(bytes));
      return `"etag-${partNumber}"`;
    },
    completeShaUpload: async (targetSha, _uploadId, parts) => {
      final.set(targetSha, Buffer.concat(parts.map((p) => uploaded.get(p.partNumber)!)));
    },
    abortShaUpload: async () => undefined,
    beginTemporaryUpload: async () => {
      throw new Error('not used');
    },
    uploadTemporaryPart: async () => {
      throw new Error('not used');
    },
    completeTemporaryUpload: async () => {
      throw new Error('not used');
    },
    abortTemporaryUpload: async () => undefined,
    putTemporary: async () => {
      throw new Error('not used');
    },
    putTemporaryStream: async () => {
      throw new Error('not used');
    },
    statTemporary: async () => null,
    copyTemporaryToSha: async () => {
      throw new Error('outbox-resident bytes must not use CopyObject');
    },
    deleteTemporary: async () => undefined,
    presignTemporaryPut: async () => new URL('https://provider.invalid/put'),
    presignTemporaryPart: async () => new URL('https://provider.invalid/part'),
    presignShaGet: async () => new URL('https://provider.invalid/get'),
  };
  const store: BlobStore = {
    kind: 'multipart-final',
    put: async (targetSha, bytes) => void final.set(targetSha, Buffer.from(bytes)),
    get: async (targetSha, range) => {
      const bytes = final.get(targetSha);
      return bytes ? rangeOf(bytes, range) : null;
    },
    has: async (targetSha) => final.has(targetSha),
    delete: async (targetSha) => void final.delete(targetSha),
    list: async () => [...final.keys()],
    stat: async (targetSha) => {
      const bytes = final.get(targetSha);
      return bytes ? { size: bytes.length } : null;
    },
  };
  const remote: RemoteTier = {
    store,
    transfer,
    storageClassFor: storageClassFor(h, SUPPORTED, DEFAULT_BACKUP_POLICY),
  };
  await drainOutboxRow(
    {
      state: h.state,
      local: h.local,
      cache: h.cache,
      remote: () => remote,
      onReplicated: () => undefined,
    },
    h.state.outbox(sha)!,
  );
  expect(h.state.outbox(sha)).toBeNull();
  expect(createClass).toBe('STANDARD_IA');
  expect(final.get(sha)!.equals(plain)).toBe(true);
});

test('outbox drain multipart door: an explicit vault-level class suppresses the heuristic', async () => {
  const h = openDrainHarness();
  const plain = randomBytes(33 * 1024 * 1024);
  const sha = stageOriginal(h, plain, 'video/mp4');
  const policy = resolveBackupPolicy({ storageClass: 'DEEP_ARCHIVE' });
  let createClass: string | undefined = 'unset';
  const final = new Map<string, Buffer>();
  const uploaded = new Map<number, Buffer>();
  const transfer: Partial<RemoteBlobTransfer> = {
    beginShaUpload: async (_sha, storageClass) => {
      createClass = storageClass;
      return 'u1';
    },
    uploadShaPart: async (_sha, _u, partNumber, bytes) => {
      uploaded.set(partNumber, Buffer.from(bytes));
      return `"e-${partNumber}"`;
    },
    completeShaUpload: async (targetSha, _u, parts) => {
      final.set(targetSha, Buffer.concat(parts.map((p) => uploaded.get(p.partNumber)!)));
    },
    abortShaUpload: async () => undefined,
  };
  const store: BlobStore = {
    kind: 'multipart-explicit',
    put: async (targetSha, bytes) => void final.set(targetSha, Buffer.from(bytes)),
    get: async (targetSha, range) => {
      const bytes = final.get(targetSha);
      return bytes ? rangeOf(bytes, range) : null;
    },
    has: async (targetSha) => final.has(targetSha),
    delete: async () => undefined,
    list: async () => [...final.keys()],
    stat: async (targetSha) => {
      const bytes = final.get(targetSha);
      return bytes ? { size: bytes.length } : null;
    },
  };
  // The instance store carries DEEP_ARCHIVE itself; the per-write override the
  // heuristic would compute is undefined, so beginShaUpload gets no override.
  const remote: RemoteTier = {
    store,
    transfer: transfer as RemoteBlobTransfer,
    storageClassFor: storageClassFor(h, SUPPORTED, policy),
  };
  await drainOutboxRow(
    {
      state: h.state,
      local: h.local,
      cache: h.cache,
      remote: () => remote,
      onReplicated: () => undefined,
    },
    h.state.outbox(sha)!,
  );
  expect(createClass).toBeUndefined();
});
