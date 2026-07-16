/*
 * End-to-end coverage for issue #367 §C — the vault blob CAS's S3-compatible
 * remote tier — against a REAL S3-compatible HTTP server
 * (`@centraid/backup`'s committed `S3TestServer`, the same one
 * `remote-provider.test.ts`/`interop-clawgnition.test.ts` use). No moto, no
 * mocked fetch: `S3BlobStore` signs real SigV4 requests over real sockets,
 * `BlobCustody` drives real AES-256-GCM sealing, and every assertion reads
 * back either through the client (round-trip) or through the test server's
 * direct object map (raw-bytes / ciphertext checks).
 *
 * Covers: S3BlobStore round-trip incl. the multipart path (§C8), replication
 * sweep + sealed-object verification (§C3/§C4), reconcile orphan deletion,
 * the lease-gate skip (§C6), and endpoint-rotation reset (§C9).
 */

import { afterAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import { S3TestServer } from '@centraid/backup/dist/testing/s3-test-server.js';
import {
  BlobCustody,
  FsBlobStore,
  MULTIPART_THRESHOLD_BYTES,
  S3BlobStore,
  ephemeralSealKey,
  sealBlob,
  sealBlobStream,
  unsealBlob,
  type RemoteTier,
} from '@centraid/vault';

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startServer(): Promise<S3TestServer> {
  const server = await S3TestServer.start();
  cleanups.push(() => server.close());
  return server;
}

const BUCKET = 'test-bucket';
const CREDS = { accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret_test' };

function makeS3(
  server: S3TestServer,
  prefix: string,
  opts: { throttleBytesPerSec?: number } = {},
): S3BlobStore {
  return new S3BlobStore({
    endpoint: server.url,
    bucket: BUCKET,
    region: 'us-east-1',
    prefix,
    credentials: async () => CREDS,
    ...opts,
  });
}

describe('S3BlobStore round-trip (real server, incl. multipart)', () => {
  test('small blob: single PUT round-trips byte-exact', async () => {
    const server = await startServer();
    const s3 = makeS3(server, 'vault1');
    const bytes = crypto.randomBytes(4096);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    await s3.put(sha, bytes);
    const back = await s3.get(sha);
    expect(back?.equals(bytes)).toBe(true);
    expect(await s3.list()).toEqual([sha]);
  });

  test('large blob (> MULTIPART_THRESHOLD_BYTES): putStream drives real multipart and round-trips byte-exact', async () => {
    const server = await startServer();
    const s3 = makeS3(server, 'vault1');
    const size = MULTIPART_THRESHOLD_BYTES + 5 * 1024 * 1024; // force multipart
    const bytes = crypto.randomBytes(size);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');

    await s3.putStream(sha, Readable.from([bytes]), size);

    // Prove multipart actually ran, not a silent fallback to one PUT: the
    // test server saw a `?uploads` initiate, at least 2 part PUTs, and a
    // `?uploadId=` complete POST.
    const initiated = server.requests.some(
      (r) => r.method === 'POST' && r.path.includes('uploads'),
    );
    const partPuts = server.requests.filter(
      (r) => r.method === 'PUT' && r.path.includes('partNumber'),
    );
    const completed = server.requests.some(
      (r) => r.method === 'POST' && r.path.includes('uploadId') && !r.path.includes('uploads'),
    );
    expect(initiated).toBe(true);
    expect(partPuts.length).toBeGreaterThanOrEqual(2);
    expect(completed).toBe(true);

    const back = await s3.get(sha);
    expect(back?.length).toBe(size);
    expect(back?.equals(bytes)).toBe(true);
  });

  test('putStream below the threshold falls back to a single PUT (no multipart calls)', async () => {
    const server = await startServer();
    const s3 = makeS3(server, 'vault1');
    const bytes = crypto.randomBytes(1024);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    await s3.putStream(sha, Readable.from([bytes]), bytes.length);
    expect(server.requests.some((r) => r.path.includes('uploads'))).toBe(false);
    const back = await s3.get(sha);
    expect(back?.equals(bytes)).toBe(true);
  });
});

describe('BlobCustody replication against a real S3-compatible server', () => {
  async function makeCustody(server: S3TestServer, dir: string, prefix: string) {
    const local = new FsBlobStore(path.join(dir, 'blobs'));
    const sealKey = ephemeralSealKey();
    const remote = (): RemoteTier | null => ({
      store: makeS3(server, prefix),
      encryptKey: sealKey,
    });
    return { custody: new BlobCustody(local, remote), local, sealKey };
  }

  test('replicate() seals remote objects — raw bytes on the wire are ciphertext, not plaintext', async () => {
    const server = await startServer();
    const dir = await tempDir('custody-seal');
    const { custody, sealKey } = await makeCustody(server, dir, 'vaultA');

    const plaintext = Buffer.from('the quick brown fox jumps over the lazy dog');
    const { sha256: sha } = custody.ingestSync(plaintext);

    const moved = await custody.replicate([sha]);
    expect(moved).toEqual([sha]);

    // Raw bytes straight off the test server's object map — never through
    // the client's own unseal path, so this can't be fooled by a client bug
    // that seals on write and silently un-seals wrong on read.
    const raw = server.getObjectDirect(BUCKET, `vaultA/blobs/sha256/${sha}`);
    expect(raw).toBeDefined();
    expect(raw!.equals(plaintext)).toBe(false); // NOT plaintext on the wire
    expect(raw!.includes(plaintext)).toBe(false); // not even a plaintext substring

    const unsealed = unsealBlob(sealKey, sha, raw!);
    expect(unsealed.equals(plaintext)).toBe(true); // but it decrypts back correctly
  });

  test('reconcile() replicates missing shas and deletes remote orphans', async () => {
    const server = await startServer();
    const dir = await tempDir('custody-reconcile');
    const { custody } = await makeCustody(server, dir, 'vaultC');

    const { sha256: liveSha } = custody.ingestSync(Buffer.from('live content'));
    // An orphan: present remotely (seeded directly), no local claim, and NOT
    // in the live set — reconcile should delete it.
    const orphanSha = crypto.createHash('sha256').update('orphan').digest('hex');
    server.putObjectDirect(BUCKET, `vaultC/blobs/sha256/${orphanSha}`, Buffer.from('orphan bytes'));

    const result = await custody.reconcile(new Set([liveSha]));
    expect(result.replicated).toContain(liveSha);
    expect(result.orphansDeleted).toContain(orphanSha);
    expect(result.orphansSkipped).toEqual([]);
    expect(server.hasObjectDirect(BUCKET, `vaultC/blobs/sha256/${orphanSha}`)).toBe(false);
  });

  test('lease-gated reconcile (skipOrphanDelete) leaves orphans in place and reports them', async () => {
    const server = await startServer();
    const dir = await tempDir('custody-lease-gate');
    const { custody } = await makeCustody(server, dir, 'vaultD');

    const orphanSha = crypto.createHash('sha256').update('lease-gate-orphan').digest('hex');
    server.putObjectDirect(BUCKET, `vaultD/blobs/sha256/${orphanSha}`, Buffer.from('orphan bytes'));

    const result = await custody.reconcile(new Set(), { skipOrphanDelete: true });
    expect(result.orphansDeleted).toEqual([]);
    expect(result.orphansSkipped).toContain(orphanSha);
    // Still there — a conflicted gateway instance must never delete what
    // might be the OTHER instance's live write.
    expect(server.hasObjectDirect(BUCKET, `vaultD/blobs/sha256/${orphanSha}`)).toBe(true);

    // Once the lease conflict clears, a normal reconcile finishes the job.
    const cleared = await custody.reconcile(new Set());
    expect(cleared.orphansDeleted).toContain(orphanSha);
  });

  test('endpoint/bucket rotation (issue #367 §C9): old prefix untouched, new prefix starts empty and re-replicates', async () => {
    const server = await startServer();
    const dir = await tempDir('custody-rotate');
    const local = new FsBlobStore(path.join(dir, 'blobs'));
    const sealKey = ephemeralSealKey();

    let currentPrefix = 'vaultE-old';
    const remote = (): RemoteTier => ({
      store: makeS3(server, currentPrefix),
      encryptKey: sealKey,
    });
    const custody = new BlobCustody(local, remote);

    const { sha256: sha } = custody.ingestSync(Buffer.from('rotated blob'));
    await custody.replicate([sha]);
    expect(await makeS3(server, 'vaultE-old').list()).toEqual([sha]);

    // Rotate — a real caller does this by changing `blob_store.endpoint`/
    // `bucket` (or `connectionId`) in vault settings; here it's the same
    // effect at the `remoteTier()` seam directly.
    currentPrefix = 'vaultE-new';

    // The old prefix's object is untouched — nothing ever addresses it again.
    expect(server.hasObjectDirect(BUCKET, 'vaultE-old/blobs/sha256/' + sha)).toBe(true);

    // The new prefix is empty, so a fresh reconcile reads this sha as
    // local-only and replicates it fresh — never treating the old remote
    // copy as if it already covered the new target.
    const before = await custody.statusFor([sha]);
    expect(before.get(sha)).toBe('local-only');
    const result = await custody.reconcile(new Set([sha]));
    expect(result.replicated).toContain(sha);
    expect(await makeS3(server, 'vaultE-new').list()).toEqual([sha]);
  });

  test('sealBlob/sealBlobStream produce the same framed wire shape (modulo per-frame nonces) and both round-trip through unsealBlob', async () => {
    // Issue #405 §1: the remote-tier seal is now FRAMED (CBSF header, per-frame
    // GCM `nonce|ct|tag` + `[algoId]` compression, sealed directory + trailer)
    // rather than a single whole-blob `nonce|ct|tag` envelope. The buffered and
    // streaming sealers are two implementations of ONE format, so they must
    // agree on the wire shape byte-for-byte EXCEPT for the random per-frame
    // nonces — same frame count, same compression verdicts (content-derived,
    // deterministic), so identical sealed lengths. Both must round-trip.
    const key = ephemeralSealKey();
    const sha = crypto.createHash('sha256').update('stream-vs-buffer').digest('hex');
    // Multiple frames at a small frame size, with an odd tail, so the streaming
    // frame carver is exercised across chunk boundaries — and incompressible
    // (random) so both paths store frames verbatim and land on equal lengths.
    const frameSize = 64 * 1024;
    const plaintext = crypto.randomBytes(frameSize * 3 + 777);

    const buffered = sealBlob(key, sha, plaintext, frameSize);

    const chunks: Buffer[] = [];
    const transform = sealBlobStream(key, sha, plaintext.length, frameSize);
    const source = Readable.from(chunkEvery(plaintext, 7 * 1024)); // awkward chunk size
    await new Promise<void>((resolve, reject) => {
      source
        .pipe(transform)
        .on('data', (c: Buffer) => chunks.push(c))
        .on('end', () => resolve())
        .on('error', reject);
    });
    const streamed = Buffer.concat(chunks);

    // Same framed wire shape: identical total length (per-frame nonces differ,
    // but nonce size is fixed, so the byte COUNT is invariant across paths).
    expect(streamed.length).toBe(buffered.length);
    // Both decrypt back to the same plaintext (the nonces differ, so the sealed
    // bytes themselves are NOT expected to be identical).
    expect(unsealBlob(key, sha, buffered).equals(plaintext)).toBe(true);
    expect(unsealBlob(key, sha, streamed).equals(plaintext)).toBe(true);
  });
});

function* chunkEvery(buf: Buffer, size: number): Generator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, Math.min(i + size, buf.length));
}
