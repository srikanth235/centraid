import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_BACKUP_POLICY } from '../backup-policy.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { BlobCache } from './cache.js';
import type { RemoteTier } from './custody-types.js';
import { FsBlobStore } from './local.js';
import { drainOutboxRow } from './outbox-drain.js';
import type { MultipartPart, RemoteBlobTransfer } from './remote-transfer.js';
import { sealBlob, unsealBlob } from './seal.js';
import type { BlobRange, BlobStat, BlobStore } from './store.js';
import { sha256OfBytes } from './store.js';
import { ReplicaIndex } from './replica-index.js';
import { desiredStoreForSha } from './store-routing.js';
import { BlobTransferState } from './transfer-state.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function rangeOf(bytes: Buffer, range?: BlobRange): Buffer {
  if (!range) return Buffer.from(bytes);
  return Buffer.from(bytes.subarray(range.start, (range.end ?? bytes.length - 1) + 1));
}

async function collect(source: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of source as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

test('known-sha outbox writes CBSF straight to the final CAS key', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blob-outbox-direct-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db: VaultDb = openVaultDb({ dir });
  cleanups.push(() => db.close());
  await db.blobTransfers.close();
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const cache = new BlobCache(db.vault, local, {
    qosCooldownMs: 0,
    settings: () => ({ budgetBytes: Number.MAX_SAFE_INTEGER }),
  });
  const state = new BlobTransferState(db.vault);
  const plain = randomBytes(128 * 1024);
  const sha = sha256OfBytes(plain);
  const key = Buffer.alloc(32, 0x39);
  local.putSync(sha, plain);
  state.enqueue(sha, plain.length);

  const final = new Map<string, Buffer>();
  const store: BlobStore = {
    kind: 'direct-final-fake',
    put: async () => {
      throw new Error('ordinary known-sha upload must stay on the streaming seam');
    },
    putStream: async (targetSha, source) => void final.set(targetSha, await collect(source)),
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
  const transfer: RemoteBlobTransfer = {
    beginTemporaryUpload: async () => {
      throw new Error('ordinary known-sha upload must not create a temp multipart');
    },
    uploadTemporaryPart: async () => {
      throw new Error('ordinary known-sha upload must not write a temp part');
    },
    completeTemporaryUpload: async () => {
      throw new Error('ordinary known-sha upload must not complete a temp object');
    },
    abortTemporaryUpload: async () => undefined,
    putTemporary: async () => {
      throw new Error('ordinary known-sha upload must not write a temp object');
    },
    putTemporaryStream: async () => {
      throw new Error('ordinary known-sha upload must not stream to a temp object');
    },
    statTemporary: async () => null,
    copyTemporaryToSha: async () => {
      throw new Error('ordinary known-sha upload must not need CopyObject');
    },
    deleteTemporary: async () => undefined,
    presignTemporaryPut: async () => new URL('https://provider.invalid/put'),
    presignTemporaryPart: async () => new URL('https://provider.invalid/part'),
    presignShaGet: async () => new URL('https://provider.invalid/get'),
  };
  const remote: RemoteTier = { store, transfer, keyFor: () => key, frameSize: 32 * 1024 };

  await drainOutboxRow(
    { state, local, cache, remote: () => remote, onReplicated: () => undefined },
    state.outbox(sha)!,
  );

  expect(state.outbox(sha)).toBeNull();
  expect([...final.keys()]).toEqual([sha]);
  expect(unsealBlob(key, sha, final.get(sha)!).equals(plain)).toBe(true);
});

test('outbox drain routes a binary derivative to the derived store (issue #425 Wave 2)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blob-outbox-derived-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db: VaultDb = openVaultDb({ dir });
  cleanups.push(() => db.close());
  await db.blobTransfers.close();
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const cache = new BlobCache(db.vault, local, {
    qosCooldownMs: 0,
    settings: () => ({ budgetBytes: Number.MAX_SAFE_INTEGER }),
  });
  const state = new BlobTransferState(db.vault);
  const plain = randomBytes(64 * 1024);
  const sha = sha256OfBytes(plain);
  const key = Buffer.alloc(32, 0x5b);
  local.putSync(sha, plain);
  state.enqueue(sha, plain.length);
  // Record the sha as a binary derivative so `desiredStoreForSha` → 'derived'.
  db.vault
    .prepare(
      `INSERT INTO blob_staging
         (staging_id, sha256, media_type, byte_size, variant, variant_of, staged_at)
       VALUES (?, ?, ?, ?, 'thumb', ?, ?)`,
    )
    .run('stage-thumb-1', sha, 'image/png', plain.length, '0'.repeat(64), new Date().toISOString());

  const casMap = new Map<string, Buffer>();
  const derivedMap = new Map<string, Buffer>();
  const makeStore = (kind: string, map: Map<string, Buffer>): BlobStore => ({
    kind,
    put: async (targetSha, bytes) => void map.set(targetSha, bytes),
    get: async (targetSha, range) => {
      const bytes = map.get(targetSha);
      return bytes ? rangeOf(bytes, range) : null;
    },
    has: async (targetSha) => map.has(targetSha),
    delete: async (targetSha) => void map.delete(targetSha),
    list: async () => [...map.keys()],
    stat: async (targetSha) => {
      const bytes = map.get(targetSha);
      return bytes ? { size: bytes.length } : null;
    },
  });
  const remote: RemoteTier = {
    store: makeStore('cas-fake', casMap),
    derivedStore: makeStore('derived-fake', derivedMap),
    keyFor: () => key,
    frameSize: 32 * 1024,
  };

  await drainOutboxRow(
    {
      state,
      local,
      cache,
      remote: () => remote,
      onReplicated: () => undefined,
      desiredStore: (s) => desiredStoreForSha(db.vault, s),
    },
    state.outbox(sha)!,
  );

  expect(state.outbox(sha)).toBeNull();
  expect(derivedMap.has(sha)).toBe(true);
  expect(casMap.has(sha)).toBe(false);
  expect(unsealBlob(key, sha, derivedMap.get(sha)!).equals(plain)).toBe(true);
  expect(new ReplicaIndex(db.vault).storeOf(sha)).toBe('derived');
});

test('outbox-resident multipart resumes directly at the final SHA without CopyObject', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blob-outbox-resume-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db: VaultDb = openVaultDb({ dir });
  cleanups.push(() => db.close());
  await db.blobTransfers.close();
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const cache = new BlobCache(db.vault, local, {
    qosCooldownMs: 0,
    settings: () => ({ budgetBytes: Number.MAX_SAFE_INTEGER }),
  });
  const state = new BlobTransferState(db.vault);
  const plain = randomBytes(33 * 1024 * 1024);
  expect(DEFAULT_BACKUP_POLICY.outboxBudgetBytes).toBeGreaterThan(plain.length);
  const sha = sha256OfBytes(plain);
  const key = Buffer.alloc(32, 0x4a);
  local.putSync(sha, plain);
  state.enqueue(sha, plain.length);

  const final = new Map<string, Buffer>();
  const uploaded = new Map<number, Buffer>();
  const calls = new Map<number, number>();
  let failSecondPart = true;
  const transfer: RemoteBlobTransfer = {
    beginShaUpload: async (targetSha) => {
      expect(targetSha).toBe(sha);
      return 'upload-1';
    },
    uploadShaPart: async (targetSha, _uploadId, partNumber, bytes) => {
      expect(targetSha).toBe(sha);
      calls.set(partNumber, (calls.get(partNumber) ?? 0) + 1);
      if (partNumber === 2 && failSecondPart) {
        failSecondPart = false;
        throw new Error('provider interrupted part 2');
      }
      uploaded.set(partNumber, Buffer.from(bytes));
      return `"etag-${partNumber}"`;
    },
    completeShaUpload: async (targetSha, _uploadId, parts) => {
      final.set(targetSha, Buffer.concat(parts.map((part) => uploaded.get(part.partNumber)!)));
    },
    abortShaUpload: async () => undefined,
    beginTemporaryUpload: async () => {
      throw new Error('outbox-resident bytes must not create a temporary object');
    },
    uploadTemporaryPart: async () => {
      throw new Error('outbox-resident bytes must not upload a temporary part');
    },
    completeTemporaryUpload: async () => {
      throw new Error('outbox-resident bytes must not complete a temporary object');
    },
    abortTemporaryUpload: async () => undefined,
    putTemporary: async () => {
      throw new Error('outbox-resident bytes must not PUT a temporary object');
    },
    putTemporaryStream: async () => {
      throw new Error('not used');
    },
    statTemporary: async (): Promise<BlobStat | null> => null,
    copyTemporaryToSha: async () => {
      throw new Error('outbox-resident bytes must not use CopyObject');
    },
    deleteTemporary: async () => undefined,
    presignTemporaryPut: async () => new URL('https://provider.invalid/put'),
    presignTemporaryPart: async () => new URL('https://provider.invalid/part'),
    presignShaGet: async () => new URL('https://provider.invalid/get'),
  };
  const store: BlobStore = {
    kind: 'resume-fake',
    put: async (targetSha, bytes) => {
      final.set(targetSha, Buffer.from(bytes));
    },
    get: async (targetSha, range) => {
      const bytes = final.get(targetSha);
      return bytes ? rangeOf(bytes, range) : null;
    },
    has: async (targetSha) => final.has(targetSha),
    delete: async (targetSha) => {
      final.delete(targetSha);
    },
    list: async () => [...final.keys()],
    stat: async (targetSha) => {
      const bytes = final.get(targetSha);
      return bytes ? { size: bytes.length } : null;
    },
  };
  const remote: RemoteTier = { store, transfer, keyFor: () => key, frameSize: 1024 * 1024 };
  const deps = { state, local, cache, remote: () => remote, onReplicated: () => undefined };

  await expect(drainOutboxRow(deps, state.outbox(sha)!)).rejects.toThrow(
    'provider interrupted part 2',
  );
  expect(JSON.parse(state.outbox(sha)!.parts_json)).toEqual([
    { partNumber: 1, etag: '"etag-1"' },
  ] satisfies MultipartPart[]);

  await drainOutboxRow(deps, state.outbox(sha)!);
  expect(calls.get(1)).toBe(1);
  expect(state.outbox(sha)).toBeNull();
  expect(unsealBlob(key, sha, final.get(sha)!).equals(plain)).toBe(true);
});

test('existing corrupt, zero, or size-stale provider objects are replaced before custody ack', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blob-outbox-corrupt-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db: VaultDb = openVaultDb({ dir });
  cleanups.push(() => db.close());
  await db.blobTransfers.close();
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const cache = new BlobCache(db.vault, local, {
    qosCooldownMs: 0,
    settings: () => ({ budgetBytes: Number.MAX_SAFE_INTEGER }),
  });
  const state = new BlobTransferState(db.vault);
  const key = Buffer.alloc(32, 0x5b);
  const final = new Map<string, Buffer>();
  let puts = 0;
  const store: BlobStore = {
    kind: 'integrity-fake',
    put: async (sha, bytes) => {
      puts += 1;
      final.set(sha, Buffer.from(bytes));
    },
    get: async (sha, range) => {
      const bytes = final.get(sha);
      return bytes ? rangeOf(bytes, range) : null;
    },
    has: async (sha) => final.has(sha),
    delete: async (sha) => void final.delete(sha),
    list: async () => [...final.keys()],
    stat: async (sha) => {
      const bytes = final.get(sha);
      return bytes ? { size: bytes.length } : null;
    },
  };
  const remote: RemoteTier = { store, keyFor: () => key, frameSize: 32 };
  const badObjects = [
    Buffer.alloc(0),
    Buffer.from('not-cbsf'),
    (sha: string) => sealBlob(key, sha, Buffer.from('wrong-size'), 32),
  ];

  for (const [index, bad] of badObjects.entries()) {
    const plain = Buffer.from(`authoritative local object ${index} with enough bytes`);
    const sha = sha256OfBytes(plain);
    local.putSync(sha, plain);
    state.enqueue(sha, plain.length);
    final.set(sha, typeof bad === 'function' ? bad(sha) : bad);
    await drainOutboxRow(
      {
        state,
        local,
        cache,
        remote: () => remote,
        onReplicated: () => undefined,
      },
      state.outbox(sha)!,
    );
    expect(state.outbox(sha)).toBeNull();
    expect(unsealBlob(key, sha, final.get(sha)!).equals(plain)).toBe(true);
  }
  expect(puts).toBe(3);
});

test('close fencing is rechecked after remote verification before SQLite settlement', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blob-outbox-close-fence-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db: VaultDb = openVaultDb({ dir });
  cleanups.push(() => db.close());
  await db.blobTransfers.close();
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const cache = new BlobCache(db.vault, local, {
    qosCooldownMs: 0,
    settings: () => ({ budgetBytes: Number.MAX_SAFE_INTEGER }),
  });
  const state = new BlobTransferState(db.vault);
  const plain = Buffer.from('provider-confirmed bytes whose range read outlives close');
  const sha = sha256OfBytes(plain);
  local.putSync(sha, plain);
  state.enqueue(sha, plain.length);

  let settle = true;
  let verificationStarted!: () => void;
  let releaseVerification!: () => void;
  const started = new Promise<void>((resolve) => (verificationStarted = resolve));
  const release = new Promise<void>((resolve) => (releaseVerification = resolve));
  const store: BlobStore = {
    kind: 'close-fence-fake',
    put: async () => undefined,
    get: async (_targetSha, range) => {
      verificationStarted();
      await release;
      return rangeOf(plain, range);
    },
    has: async () => true,
    delete: async () => undefined,
    list: async () => [sha],
    stat: async () => ({ size: plain.length }),
  };

  const draining = drainOutboxRow(
    {
      state,
      local,
      cache,
      remote: () => ({ store }),
      onReplicated: () => undefined,
      settlementAllowed: () => settle,
    },
    state.outbox(sha)!,
  );
  await started;
  settle = false;
  releaseVerification();
  await draining;

  expect(state.outbox(sha)).not.toBeNull();
  expect(cache.replica.has(sha)).toBe(false);
});
