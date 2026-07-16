// Direct-to-IA storage class for large media originals (issue #425 Wave 3
// Part B) — the remote-primary ingress doors, where the CAS object is minted
// BEFORE the staging row exists, so the class is resolved from a media hint the
// door hands in directly:
//   - the low-level S3 CopyObject unit (direct-upload promotion), and
//   - the gateway-mediated multipart stream-through (beginIngress →
//     commitIngress), covered end-to-end here.
// The pure eligibility resolver and the local-first outbox-drain doors that
// resolve the class from an already-written `blob_staging` row live alongside in
// direct-cold-originals.test.ts.

import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { resolveBackupPolicy, type BackupPolicy } from '../backup-policy.js';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { BlobCache } from './cache.js';
import { BlobContentKeyRegistry } from './content-keys.js';
import type { RemoteTier } from './custody-types.js';
import { FsBlobStore } from './local.js';
import type { RemoteBlobTransfer } from './remote-transfer.js';
import { S3TransferStore } from './s3-transfer.js';
import { unsealBlob } from './seal.js';
import type { BlobRange, BlobStat, BlobStore } from './store.js';
import { sha256OfBytes } from './store.js';
import { COLD_ORIGINAL_STORAGE_CLASS, storageClassForShaWrite } from './store-routing.js';
import { BlobTransferCoordinator } from './transfers.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const SUPPORTED = ['STANDARD', 'STANDARD_IA'];

function rangeOf(bytes: Buffer, range?: BlobRange): Buffer {
  if (!range) return Buffer.from(bytes);
  return Buffer.from(bytes.subarray(range.start, (range.end ?? bytes.length - 1) + 1));
}

// ---------- the CopyObject (direct-upload promotion) door ----------

interface FakeS3 {
  url: string;
  requests: { method: string; storageClass: string | null; copySource: string | null }[];
  close(): Promise<void>;
}

function startFakeS3(): Promise<FakeS3> {
  const requests: { method: string; storageClass: string | null; copySource: string | null }[] = [];
  const server = http.createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      storageClass:
        typeof req.headers['x-amz-storage-class'] === 'string'
          ? (req.headers['x-amz-storage-class'] as string)
          : null,
      copySource:
        typeof req.headers['x-amz-copy-source'] === 'string'
          ? (req.headers['x-amz-copy-source'] as string)
          : null,
    });
    req.on('data', () => undefined);
    req.on('end', () => void res.writeHead(200).end());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      });
    });
  });
}

test('CopyObject door: copyTemporaryToSha rides the override onto the object-creating copy', async () => {
  const fake = await startFakeS3();
  cleanups.push(() => fake.close());
  const transfer = new S3TransferStore({
    endpoint: fake.url,
    bucket: 'test-bucket',
    prefix: 'v/acct',
    credentials: () => Promise.resolve({ accessKeyId: 'AK', secretAccessKey: 'SK' }),
  });
  const sha = 'd'.repeat(64);
  await transfer.copyTemporaryToSha('direct-1', sha, COLD_ORIGINAL_STORAGE_CLASS);
  const copy = fake.requests.find((r) => r.copySource !== null);
  expect(copy?.method).toBe('PUT');
  expect(copy?.storageClass).toBe('STANDARD_IA');

  // No override + no instance class ⇒ a class-less copy.
  await transfer.copyTemporaryToSha('direct-2', sha);
  const bare = fake.requests.findLast((r) => r.copySource !== null);
  expect(bare?.storageClass).toBeNull();
});

// ---------- the gateway-mediated stream-through door (end-to-end-ish) ----------
//
// The large-media originals the heuristic targets take the streaming path, and a
// streamed original's CAS object is minted BEFORE its `blob_staging` row exists —
// so a sha-only DB lookup would be empty at promote time. This drives the real
// coordinator (seal → temp multipart → CopyObject promote → verify → record) and
// asserts the promote carries STANDARD_IA off the media hint the door hands in.

interface StreamHarness {
  db: VaultDb;
  keys: BlobContentKeyRegistry;
  coordinator: () => BlobTransferCoordinator;
  classOf: Map<string, string | undefined>;
  objects: Map<string, Buffer>;
}

async function collectStream(source: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const value of source as AsyncIterable<Buffer | string>)
    chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  return Buffer.concat(chunks);
}

function openStreamHarness(
  policy: BackupPolicy,
  supported: readonly string[] | undefined,
): StreamHarness {
  const dir = mkdtempSync(path.join(tmpdir(), 'blob-cold-stream-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db = openVaultDb({ dir });
  cleanups.push(() => db.close());
  db.blobTransfers.abandon();
  bootstrapVault(db, { ownerName: 'Ravi' });
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const merged: BackupPolicy = { ...policy, cacheBudgetBytes: 1, reservedHeadroomBytes: 0 };
  const cache = new BlobCache(db.vault, local, { policy: () => merged });
  const keys = new BlobContentKeyRegistry(db.vault, db.sealKey);
  const objects = new Map<string, Buffer>();
  const temporary = new Map<string, Buffer>();
  const uploads = new Map<string, Map<number, Buffer>>();
  const classOf = new Map<string, string | undefined>();
  const store: BlobStore = {
    kind: 'fake-cold-stream',
    put: async (sha, bytes) => void objects.set(sha, Buffer.from(bytes)),
    get: async (sha, range) => {
      const b = objects.get(sha);
      return b ? rangeOf(b, range) : null;
    },
    has: async (sha) => objects.has(sha),
    delete: async (sha) => void objects.delete(sha),
    list: async () => [...objects.keys()],
    stat: async (sha): Promise<BlobStat | null> => {
      const b = objects.get(sha);
      return b ? { size: b.length } : null;
    },
  };
  const transfer: RemoteBlobTransfer = {
    beginTemporaryUpload: async (tempId) => {
      uploads.set(tempId, new Map());
      return `upload-${tempId}`;
    },
    uploadTemporaryPart: async (tempId, _u, partNumber, bytes) => {
      uploads.get(tempId)?.set(partNumber, Buffer.from(bytes));
      return `etag-${partNumber}`;
    },
    completeTemporaryUpload: async (tempId, _u, parts) => {
      const saved = uploads.get(tempId)!;
      temporary.set(tempId, Buffer.concat(parts.map((p) => saved.get(p.partNumber)!)));
    },
    abortTemporaryUpload: async (tempId) => void uploads.delete(tempId),
    putTemporary: async (tempId, bytes) => void temporary.set(tempId, Buffer.from(bytes)),
    putTemporaryStream: async (tempId, source) =>
      void temporary.set(tempId, await collectStream(source)),
    statTemporary: async (tempId) => {
      const b = temporary.get(tempId);
      return b ? { size: b.length } : null;
    },
    getTemporary: async (tempId, range) => {
      const b = temporary.get(tempId);
      return b ? rangeOf(b, range) : null;
    },
    copyTemporaryToSha: async (tempId, sha, storageClass) => {
      const b = temporary.get(tempId);
      if (!b) throw new Error(`missing temporary ${tempId}`);
      classOf.set(sha, storageClass);
      objects.set(sha, Buffer.from(b));
    },
    deleteTemporary: async (tempId) => {
      temporary.delete(tempId);
      uploads.delete(tempId);
    },
    presignTemporaryPut: async () => new URL('https://s3.invalid/put'),
    presignTemporaryPart: async () => new URL('https://s3.invalid/part'),
    presignShaGet: async () => new URL('https://s3.invalid/get'),
  };
  const remote: RemoteTier = {
    store,
    transfer,
    keyFor: (sha) => keys.getOrCreate(sha),
    frameSize: 1024 * 1024,
    storageClassFor: (sha, storeClass, hint) =>
      storageClassForShaWrite(db.vault, sha, storeClass, supported, merged, hint),
  };
  const coordinator = () => {
    const value = new BlobTransferCoordinator({
      vault: db.vault,
      dir,
      local,
      cache,
      remote: () => remote,
      remoteConfigured: () => true,
      policy: () => merged,
      contentKeys: keys,
      drainIntervalMs: 60_000,
      streamChunkBytes: 1024 * 1024,
    });
    cleanups.push(() => value.close());
    return value;
  };
  return { db, keys, coordinator, classOf, objects };
}

async function streamThroughIngress(
  coordinator: BlobTransferCoordinator,
  plain: Buffer,
  mediaType: string,
): Promise<string> {
  const sha = sha256OfBytes(plain);
  const begun = await coordinator.beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
    mediaType,
    stagedBy: 'device-a',
    resumable: true,
  });
  if (begun.mode !== 'stream-through')
    throw new Error(`expected stream-through, got ${begun.mode}`);
  await coordinator.appendIngress(begun.sessionId, 0, plain);
  const committed = await coordinator.commitIngress(begun.sessionId);
  expect(committed.sha256).toBe(sha);
  return sha;
}

test('stream-through door: an eligible large video original promotes with STANDARD_IA', async () => {
  const policy = resolveBackupPolicy({ directToColdOriginals: { minBytes: 1024 } });
  const h = openStreamHarness(policy, SUPPORTED);
  const plain = randomBytes(4096);
  const sha = await streamThroughIngress(h.coordinator(), plain, 'video/mp4');
  expect(h.classOf.get(sha)).toBe('STANDARD_IA');
  // The final CAS object still round-trips: the class rides alongside the bytes.
  expect(unsealBlob(h.keys.getOrCreate(sha), sha, h.objects.get(sha)!)).toEqual(plain);
});

test('stream-through door: an ineligible original promotes class-less (no header)', async () => {
  const policy = resolveBackupPolicy({ directToColdOriginals: { minBytes: 1024 } });
  // Non-media original at size — sniffs application/pdf, so it never goes cold.
  const h = openStreamHarness(policy, SUPPORTED);
  const sha = await streamThroughIngress(h.coordinator(), randomBytes(4096), 'application/pdf');
  expect(h.classOf.get(sha)).toBeUndefined();
});
