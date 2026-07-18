import { tempDirSync } from '@centraid/test-kit/temp-dir';
import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, test } from 'vitest';
import { readBackupPolicy } from '../backup-policy.js';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { VaultBlobBackpressureError } from '../errors.js';
import { BlobCache } from './cache.js';
import { BlobContentKeyRegistry } from './content-keys.js';
import type { RemoteTier } from './custody-types.js';
import { FsBlobStore } from './local.js';
import type { RemoteBlobTransfer } from './remote-transfer.js';
import { sealBlob, unsealBlob } from './seal.js';
import type { BlobRange, BlobStat, BlobStore } from './store.js';
import { sha256OfBytes } from './store.js';
import { BlobTransferCoordinator } from './transfers.js';

const TEST_CHUNK_BYTES = 1024 * 1024;

interface FakeRemote {
  remote: RemoteTier;
  objects: Map<string, Buffer>;
  temporary: Map<string, Buffer>;
  partUploads: number[];
  copies: { count: number };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function ranged(bytes: Buffer, range?: BlobRange): Buffer {
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

function fakeRemote(keys: BlobContentKeyRegistry): FakeRemote {
  const objects = new Map<string, Buffer>();
  const temporary = new Map<string, Buffer>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const partUploads: number[] = [];
  const copies = { count: 0 };
  const store: BlobStore = {
    kind: 'fake-stream-remote',
    put: async (sha, bytes) => void objects.set(sha, Buffer.from(bytes)),
    get: async (sha, range) => {
      const bytes = objects.get(sha);
      return bytes ? ranged(bytes, range) : null;
    },
    has: async (sha) => objects.has(sha),
    delete: async (sha) => void objects.delete(sha),
    list: async () => [...objects.keys()],
    stat: async (sha): Promise<BlobStat | null> => {
      const bytes = objects.get(sha);
      return bytes ? { size: bytes.length } : null;
    },
  };
  const transfer: RemoteBlobTransfer = {
    beginTemporaryUpload: async (tempId) => {
      uploads.set(tempId, new Map());
      return `upload-${tempId}`;
    },
    uploadTemporaryPart: async (tempId, _uploadId, partNumber, bytes) => {
      uploads.get(tempId)?.set(partNumber, Buffer.from(bytes));
      partUploads.push(partNumber);
      return `etag-${partNumber}`;
    },
    completeTemporaryUpload: async (tempId, _uploadId, parts) => {
      const saved = uploads.get(tempId);
      if (!saved) throw new Error(`missing upload ${tempId}`);
      temporary.set(tempId, Buffer.concat(parts.map((part) => saved.get(part.partNumber)!)));
    },
    abortTemporaryUpload: async (tempId) => void uploads.delete(tempId),
    putTemporary: async (tempId, bytes) => void temporary.set(tempId, Buffer.from(bytes)),
    putTemporaryStream: async (tempId, source) => void temporary.set(tempId, await collect(source)),
    statTemporary: async (tempId) => {
      const bytes = temporary.get(tempId);
      return bytes ? { size: bytes.length } : null;
    },
    getTemporary: async (tempId, range) => {
      const bytes = temporary.get(tempId);
      return bytes ? ranged(bytes, range) : null;
    },
    copyTemporaryToSha: async (tempId, sha) => {
      const bytes = temporary.get(tempId);
      if (!bytes) throw new Error(`missing temporary object ${tempId}`);
      copies.count += 1;
      objects.set(sha, Buffer.from(bytes));
    },
    deleteTemporary: async (tempId) => {
      temporary.delete(tempId);
      uploads.delete(tempId);
    },
    presignTemporaryPut: async () => new URL('https://s3.example/upload'),
    presignTemporaryPart: async () => new URL('https://s3.example/part'),
    presignShaGet: async () => new URL('https://s3.example/download'),
  };
  return {
    objects,
    temporary,
    partUploads,
    copies,
    remote: { store, transfer, keyFor: (sha) => keys.getOrCreate(sha), frameSize: 1024 * 1024 },
  };
}

async function harness(options: { budgetBytes: number; freeBytes?: number }) {
  const dir = tempDirSync('blob-stream-ingress-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db: VaultDb = openVaultDb({ dir });
  await db.blobTransfers.close();
  cleanups.push(() => db.close());
  const boot = bootstrapVault(db, { ownerName: 'Priya' });
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const policy = {
    ...readBackupPolicy(db.vault),
    cacheBudgetBytes: options.budgetBytes,
    reservedHeadroomBytes: 10 * 1024 ** 2,
  };
  const cache = new BlobCache(db.vault, local, {
    policy: () => policy,
    ...(options.freeBytes === undefined
      ? {}
      : { statfs: () => ({ bavail: options.freeBytes!, bsize: 1 }) }),
  });
  const keys = new BlobContentKeyRegistry(db.vault, db.sealKey);
  const fake = fakeRemote(keys);
  const coordinator = () => {
    const value = new BlobTransferCoordinator({
      vault: db.vault,
      dir,
      local,
      cache,
      remote: () => fake.remote,
      remoteConfigured: () => true,
      policy: () => policy,
      contentKeys: keys,
      drainIntervalMs: 60_000,
      streamChunkBytes: TEST_CHUNK_BYTES,
    });
    cleanups.push(() => value.close());
    return value;
  };
  return { db, local, cache, keys, fake, coordinator, boot };
}

test('a 500 MiB bare stream on a 200 MiB volume selects encrypted hash-pending stream-through', async () => {
  const MiB = 1024 ** 2;
  const h = await harness({ budgetBytes: 200 * MiB, freeBytes: 210 * MiB });
  const begin = await h.coordinator().beginIngress({ expectedSize: 500 * MiB });
  expect(begin).toEqual({ mode: 'one-shot-hash-pending', expectedSize: 500 * MiB });
});

test('capacity pressure plus an unreachable provider stays typed 429-ready backpressure', async () => {
  const h = await harness({ budgetBytes: 1 });
  h.fake.remote.store.stat = async () => {
    throw new Error('provider is offline');
  };
  const error = await h
    .coordinator()
    .beginIngress({ expectedSize: 100 })
    .catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(VaultBlobBackpressureError);
  expect((error as VaultBlobBackpressureError).details).toMatchObject({
    needBytes: 100,
    availableBytes: 1,
  });
});

test('hash-pending stream re-keys provider temp frames into the final per-blob CBSF object', async () => {
  const h = await harness({ budgetBytes: 1 });
  const plain = Buffer.from('hash this while the encrypted stream is already leaving disk');
  const committed = await h
    .coordinator()
    .streamThrough({ expectedSize: plain.length, filename: 'note.bin' }, Readable.from([plain]));
  const sealed = h.fake.objects.get(committed.sha256)!;
  expect(unsealBlob(h.keys.getOrCreate(committed.sha256), committed.sha256, sealed)).toEqual(plain);
  expect(h.local.hasSync(committed.sha256)).toBe(false);
  expect(h.fake.temporary.size).toBe(0);
  expect(h.fake.copies.count).toBe(1);
});

test('hash-pending duplicate authenticates the existing final object and discards only its temp', async () => {
  const h = await harness({ budgetBytes: 1 });
  const plain = Buffer.from('already in the remote content-addressed store');
  const sha = sha256OfBytes(plain);
  const sealed = sealBlob(h.keys.getOrCreate(sha), sha, plain, 1024 * 1024);
  h.fake.objects.set(sha, sealed);
  const committed = await h
    .coordinator()
    .streamThrough({ expectedSize: plain.length }, Readable.from([plain]));
  expect(committed.sha256).toBe(sha);
  expect(h.fake.objects.get(sha)).toEqual(sealed);
  expect(h.fake.copies.count).toBe(0);
  expect(h.fake.temporary.size).toBe(0);
});

test('declared-SHA preflight returns an existing receipt without opening an upload', async () => {
  const h = await harness({ budgetBytes: 1 });
  const plain = Buffer.from('preflight means the request body never needs to leave the client');
  const sha = sha256OfBytes(plain);
  h.fake.objects.set(sha, sealBlob(h.keys.getOrCreate(sha), sha, plain, 1024 * 1024));
  const result = await h.coordinator().beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
  });
  expect(result).toMatchObject({ mode: 'existing', custody: 'remote-only' });
  expect(h.fake.temporary.size).toBe(0);
  expect(h.fake.partUploads).toEqual([]);
});

test('declared-SHA stream rejects mismatched plaintext before promoting a final object', async () => {
  const h = await harness({ budgetBytes: 1 });
  const plain = Buffer.from('these bytes do not match the declared content address');
  await expect(
    h
      .coordinator()
      .streamThrough(
        { expectedSha256: '0'.repeat(64), expectedSize: plain.length },
        Readable.from([plain]),
      ),
  ).rejects.toThrow(/SHA-256 mismatch/i);
  expect(h.fake.objects.size).toBe(0);
  expect(h.fake.temporary.size).toBe(0);
});

test('direct completion HEAD- and AEAD-verifies CBSF before accepting the metadata claim', async () => {
  const h = await harness({ budgetBytes: 1 });
  const coordinator = h.coordinator();
  coordinator.enrollPairedDevice({
    identity: 'paired-phone-key',
    ownerPartyId: h.boot.ownerPartyId,
    name: 'Phone',
    trust: 'full',
  });
  const plain = Buffer.from('the paired device seals this object before transfer');
  const sha = sha256OfBytes(plain);
  const sealed = sealBlob(h.keys.getOrCreate(sha), sha, plain, 1024 * 1024);
  const initiated = await coordinator.beginDirect({
    sha256: sha,
    plaintextSize: plain.length,
    sealedSize: sealed.length,
    deviceId: 'paired-phone-key',
  });
  const row = coordinator.state.session(initiated.sessionId!);
  h.fake.temporary.set(row!.remote_temp_id!, sealed);
  const committed = await coordinator.completeDirect(initiated.sessionId!, 'paired-phone-key');
  expect(committed).toMatchObject({ sha256: sha, custody: 'remote-only' });
  expect(coordinator.state.session(initiated.sessionId!)?.state).toBe('complete');
  expect(h.cache.replica.has(sha)).toBe(true);
});

test('direct completion rejects missing, corrupt, and declared-plaintext-size-mismatched objects', async () => {
  const h = await harness({ budgetBytes: 1 });
  const coordinator = h.coordinator();
  coordinator.enrollPairedDevice({
    identity: 'paired-tablet-key',
    ownerPartyId: h.boot.ownerPartyId,
    name: 'Tablet',
    trust: 'full',
  });
  const begin = async (plain: Buffer, plaintextSize = plain.length) => {
    const sha = sha256OfBytes(plain);
    const sealed = sealBlob(h.keys.getOrCreate(sha), sha, plain, 1024 * 1024);
    const initiated = await coordinator.beginDirect({
      sha256: sha,
      plaintextSize,
      sealedSize: sealed.length,
      deviceId: 'paired-tablet-key',
    });
    return { sha, sealed, sessionId: initiated.sessionId! };
  };

  const missing = await begin(Buffer.from('missing provider temp'));
  await expect(coordinator.completeDirect(missing.sessionId, 'paired-tablet-key')).rejects.toThrow(
    /size mismatch/,
  );

  const corrupt = await begin(Buffer.from('tampered provider temp'));
  const corruptRow = coordinator.state.session(corrupt.sessionId)!;
  const tampered = Buffer.from(corrupt.sealed);
  tampered.writeUInt8(tampered.readUInt8(0) ^ 0xff, 0);
  h.fake.temporary.set(corruptRow.remote_temp_id!, tampered);
  await expect(coordinator.completeDirect(corrupt.sessionId, 'paired-tablet-key')).rejects.toThrow(
    /magic/,
  );
  expect(h.cache.replica.has(corrupt.sha)).toBe(false);

  const wrongSize = await begin(Buffer.from('declared size must bind the directory'), 999);
  const wrongRow = coordinator.state.session(wrongSize.sessionId)!;
  h.fake.temporary.set(wrongRow.remote_temp_id!, wrongSize.sealed);
  await expect(
    coordinator.completeDirect(wrongSize.sessionId, 'paired-tablet-key'),
  ).rejects.toThrow(/plaintext size mismatch/);
  expect(h.cache.replica.has(wrongSize.sha)).toBe(false);
});

test('beginDirect on a remote-held blob returns an authoritative replicated settlement', async () => {
  const h = await harness({ budgetBytes: 1 });
  const coordinator = h.coordinator();
  coordinator.enrollPairedDevice({
    identity: 'paired-phone-key',
    ownerPartyId: h.boot.ownerPartyId,
    name: 'Phone',
    trust: 'full',
  });
  const plain = Buffer.from('these bytes already live in the remote content-addressed store');
  const sha = sha256OfBytes(plain);
  const sealed = sealBlob(h.keys.getOrCreate(sha), sha, plain, 1024 * 1024);
  // Remote tier holds the sealed object ⇒ custody remote-only, casAck replicated.
  h.fake.objects.set(sha, sealed);

  const result = await coordinator.beginDirect({
    sha256: sha,
    plaintextSize: plain.length,
    sealedSize: sealed.length,
    deviceId: 'paired-phone-key',
  });
  expect(result.alreadyPresent).toBe(true);
  expect(result.sessionId).toBeUndefined();
  expect(result.custody).toBe('remote-only');
  expect(result.settlement).toMatchObject({
    alreadyPresent: true,
    sha256: sha,
    casAck: 'replicated',
    custody: 'remote-only',
    acknowledged: true,
  });
});

test('beginDirect on a local-only blob dedupes but settles as unreplicated (casAck receipt)', async () => {
  const h = await harness({ budgetBytes: 1 });
  const coordinator = h.coordinator();
  coordinator.enrollPairedDevice({
    identity: 'paired-tablet-key',
    ownerPartyId: h.boot.ownerPartyId,
    name: 'Tablet',
    trust: 'full',
  });
  const plain = Buffer.from('these bytes are on disk but not yet pushed offsite');
  const sha = sha256OfBytes(plain);
  const sealed = sealBlob(h.keys.getOrCreate(sha), sha, plain, 1024 * 1024);
  // Local tier only; the remote provider genuinely does not hold it yet.
  h.local.putSync(sha, sealed);

  const result = await coordinator.beginDirect({
    sha256: sha,
    plaintextSize: plain.length,
    sealedSize: sealed.length,
    deviceId: 'paired-tablet-key',
  });
  expect(result.alreadyPresent).toBe(true);
  expect(result.sessionId, 'a durable local copy needs no re-upload').toBeUndefined();
  expect(result.custody).toBe('local-only');
  expect(result.settlement).toMatchObject({
    alreadyPresent: true,
    casAck: 'receipt',
    custody: 'local-only',
    acknowledged: false,
  });
});

test('stream-through resumes open and committing sessions without retransmitting completed parts', async () => {
  const h = await harness({ budgetBytes: 1 });
  const plain = Buffer.alloc(TEST_CHUNK_BYTES * 2, 0x5a);
  const sha = createHash('sha256').update(plain).digest('hex');
  const first = h.coordinator();
  const begun = await first.beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
    stagedBy: 'device-a',
    resumable: true,
  });
  expect(begun.mode).toBe('stream-through');
  if (begun.mode !== 'stream-through') throw new Error('expected stream-through');
  await first.appendIngress(begun.sessionId, 0, plain.subarray(0, TEST_CHUNK_BYTES));

  const second = h.coordinator();
  const resumed = await second.beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
    stagedBy: 'device-a',
    resumable: true,
  });
  expect(resumed).toMatchObject({ mode: 'stream-through', offset: TEST_CHUNK_BYTES });
  if (resumed.mode !== 'stream-through') throw new Error('expected resumed stream-through');
  await second.appendIngress(resumed.sessionId, resumed.offset, plain.subarray(TEST_CHUNK_BYTES));
  second.state.setSessionState(resumed.sessionId, 'committing');

  const third = h.coordinator();
  const committing = await third.beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
    stagedBy: 'device-a',
    resumable: true,
  });
  expect(committing).toMatchObject({ mode: 'stream-through', offset: plain.length });
  if (committing.mode !== 'stream-through') throw new Error('expected committing session');
  const committed = await third.commitIngress(committing.sessionId);
  expect(committed).toMatchObject({ sha256: sha, custody: 'remote-only' });
  expect(h.fake.partUploads).toEqual([1, 2]);
  expect(unsealBlob(h.keys.getOrCreate(sha), sha, h.fake.objects.get(sha)!)).toEqual(plain);
}, 15_000);
