// Blob custody units (issue #296): the stores, the spool pipeline, and the
// two-tier custody facade — including the S3 driver against an in-process
// fake S3 endpoint (SigV4-signed requests over real HTTP, no SDK).

import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { BlobCustody, sealBlob, unsealBlob, type RemoteTier } from './custody.js';
import { FsBlobStore, MemoryBlobStore } from './local.js';
import { extractBlobMeta, sniffMediaType } from './pipeline.js';
import { S3BlobStore } from './s3.js';
import { sha256OfBytes } from './store.js';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

// ---------- local stores ----------

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'blob-test-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test('fs store: put/get/has/stat/list/delete round-trip, range reads, idempotent put', () => {
  const store = new FsBlobStore(path.join(tmp, 'blobs'));
  const bytes = Buffer.from('hello blob world');
  const sha = sha256OfBytes(bytes);
  store.putSync(sha, bytes);
  store.putSync(sha, bytes); // idempotent
  expect(store.hasSync(sha)).toBe(true);
  expect(store.getSync(sha)?.equals(bytes)).toBe(true);
  expect(store.getSync(sha, { start: 6, end: 9 })?.toString()).toBe('blob');
  expect(store.getSync(sha, { start: 6 })?.toString()).toBe('blob world');
  expect(store.getSync(sha, { start: 99 })).toBeNull(); // unsatisfiable
  expect(store.statSync(sha)).toEqual({ size: bytes.length });
  expect(store.listSync()).toEqual([sha]);
  store.deleteSync(sha);
  expect(store.hasSync(sha)).toBe(false);
  expect(store.getSync(sha)).toBeNull();
});

test('memory store mirrors fs semantics', () => {
  const store = new MemoryBlobStore();
  const bytes = Buffer.from('in memory');
  const sha = sha256OfBytes(bytes);
  store.putSync(sha, bytes);
  expect(store.getSync(sha, { start: 3, end: 8 })?.toString()).toBe('memory');
  expect(store.listSync()).toEqual([sha]);
  store.deleteSync(sha);
  expect(store.statSync(sha)).toBeNull();
});

test('stores refuse keys that are not sha256 hex', () => {
  const store = new MemoryBlobStore();
  expect(() => store.putSync('../etc/passwd', Buffer.from('x'))).toThrow(/not a sha256/);
});

// ---------- spool pipeline ----------

test('sniffing: magic bytes beat the declared type, declared beats extension', () => {
  expect(sniffMediaType(PNG_BYTES, 'application/octet-stream', 'x.bin')).toBe('image/png');
  expect(sniffMediaType(Buffer.from('%PDF-1.4 fake'), 'image/png')).toBe('application/pdf');
  expect(sniffMediaType(Buffer.from('plain words'), 'text/markdown')).toBe('text/markdown');
  expect(sniffMediaType(Buffer.from('plain words'), undefined, 'notes.md')).toBe('text/markdown');
  expect(sniffMediaType(Buffer.from('just text'))).toBe('text/plain');
  expect(sniffMediaType(Buffer.from([0, 1, 2, 3])).startsWith('application/')).toBe(true);
});

test('png dimensions come from the header; text extracts itself', () => {
  const meta = extractBlobMeta(PNG_BYTES, 'image/png');
  expect(meta.width).toBe(1);
  expect(meta.height).toBe(1);
  const text = extractBlobMeta(Buffer.from('# Heading\nBody words'), 'text/markdown');
  expect(text.text).toContain('Body words');
});

test('jpeg EXIF: capture time parses; GPS obeys the keepLocation gate', () => {
  const jpeg = exifJpeg();
  const kept = extractBlobMeta(jpeg, 'image/jpeg', { keepLocation: true });
  expect(kept.captured_at).toBe('2024-06-01T10:30:00');
  expect(kept.has_location).toBe(true);
  expect(kept.latitude).toBeCloseTo(37.5, 3);
  expect(kept.longitude).toBeCloseTo(-122.25, 3);
  const stripped = extractBlobMeta(jpeg, 'image/jpeg', { keepLocation: false });
  expect(stripped.has_location).toBe(true); // presence is reported...
  expect(stripped.latitude).toBeUndefined(); // ...coordinates are not
});

test('uncompressed pdf text-show operators extract; binary junk does not', () => {
  const pdf = Buffer.from(
    '%PDF-1.1\nBT (Quarterly tax receipt for the vault) Tj ET\n' +
      'BT [(second) (fragment)] TJ ET\n%%EOF',
  );
  const meta = extractBlobMeta(pdf, 'application/pdf');
  expect(meta.text).toContain('Quarterly tax receipt');
  expect(meta.text).toContain('second fragment');
  expect(
    extractBlobMeta(Buffer.from('%PDF-1.1 <compressed>'), 'application/pdf').text,
  ).toBeUndefined();
});

/**
 * Build a minimal JPEG whose APP1/EXIF block carries DateTimeOriginal
 * 2024:06:01 10:30:00 and GPS 37°30'N 122°15'W — offsets computed, not
 * hand-counted, so the fixture stays honest.
 */
function exifJpeg(): Buffer {
  const entrySize = 12;
  // TIFF layout: header(8) → IFD0(2 entries) → ExifIFD(1 entry) → GPSIFD(4
  // entries) → data area (ascii + rationals).
  const ifd0At = 8;
  const exifIfdAt = ifd0At + 2 + 2 * entrySize + 4;
  const gpsIfdAt = exifIfdAt + 2 + 1 * entrySize + 4;
  const dataAt = gpsIfdAt + 2 + 4 * entrySize + 4;
  const dto = '2024:06:01 10:30:00\0';
  const dtoAt = dataAt;
  const latAt = dtoAt + dto.length;
  const lonAt = latAt + 24;
  const tiff = Buffer.alloc(lonAt + 24);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(ifd0At, 4);
  const entry = (
    at: number,
    tag: number,
    type: number,
    count: number,
    value: number,
    inlineAscii?: string,
  ) => {
    tiff.writeUInt16LE(tag, at);
    tiff.writeUInt16LE(type, at + 2);
    tiff.writeUInt32LE(count, at + 4);
    if (inlineAscii !== undefined) tiff.write(inlineAscii, at + 8, 'latin1');
    else tiff.writeUInt32LE(value, at + 8);
  };
  // IFD0: pointers to the Exif and GPS IFDs.
  tiff.writeUInt16LE(2, ifd0At);
  entry(ifd0At + 2, 0x8769, 4, 1, exifIfdAt);
  entry(ifd0At + 2 + entrySize, 0x8825, 4, 1, gpsIfdAt);
  // Exif IFD: DateTimeOriginal (ascii lives in the data area).
  tiff.writeUInt16LE(1, exifIfdAt);
  entry(exifIfdAt + 2, 0x9003, 2, dto.length, dtoAt);
  tiff.write(dto, dtoAt, 'latin1');
  // GPS IFD: refs inline, coordinates as 3 rationals each.
  tiff.writeUInt16LE(4, gpsIfdAt);
  entry(gpsIfdAt + 2, 0x0001, 2, 2, 0, 'N\0');
  entry(gpsIfdAt + 2 + entrySize, 0x0002, 5, 3, latAt);
  entry(gpsIfdAt + 2 + 2 * entrySize, 0x0003, 2, 2, 0, 'W\0');
  entry(gpsIfdAt + 2 + 3 * entrySize, 0x0004, 5, 3, lonAt);
  const rational = (at: number, values: [number, number][]) => {
    values.forEach(([num, den], i) => {
      tiff.writeUInt32LE(num, at + i * 8);
      tiff.writeUInt32LE(den, at + i * 8 + 4);
    });
  };
  rational(latAt, [
    [37, 1],
    [30, 1],
    [0, 1],
  ]); // 37° 30' = 37.5
  rational(lonAt, [
    [122, 1],
    [15, 1],
    [0, 1],
  ]); // 122° 15' = 122.25, W → negative
  const exifBody = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt16BE(0xffe1, 0);
  app1.writeUInt16BE(exifBody.length + 2, 2);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), // SOI
    app1,
    exifBody,
    Buffer.from([0xff, 0xd9]), // EOI
  ]);
}

// ---------- custody: two tiers, encryption, reconcile ----------

test('sealBlob/unsealBlob round-trip and refuse a swapped address', () => {
  const key = Buffer.alloc(32, 7);
  const bytes = Buffer.from('secret media');
  const sha = sha256OfBytes(bytes);
  const sealed = sealBlob(key, sha, bytes);
  expect(sealed.equals(bytes)).toBe(false);
  expect(unsealBlob(key, sha, sealed).equals(bytes)).toBe(true);
  expect(() => unsealBlob(key, 'f'.repeat(64), sealed)).toThrow();
});

function makeCustody(remote: RemoteTier | null): { custody: BlobCustody; local: MemoryBlobStore } {
  const local = new MemoryBlobStore();
  return { custody: new BlobCustody(local, () => remote), local };
}

test('custody replicates local bytes to the remote tier and reconciles orphans', async () => {
  const remoteStore = new MemoryBlobStore();
  const { custody } = makeCustody({ store: remoteStore });
  const a = custody.ingestSync(Buffer.from('replicate me')).sha256;
  expect(await custody.replicate()).toEqual([a]);
  expect(remoteStore.hasSync(a)).toBe(true);
  // An orphan object nothing claims deletes on reconcile; a missing live
  // sha is reported, never invented.
  const orphan = sha256OfBytes(Buffer.from('orphan'));
  remoteStore.putSync(orphan, Buffer.from('orphan'));
  const ghost = sha256OfBytes(Buffer.from('ghost'));
  const result = await custody.reconcile(new Set([a, ghost]));
  expect(result.orphansDeleted).toEqual([orphan]);
  expect(result.missing).toEqual([ghost]);
  expect(remoteStore.hasSync(orphan)).toBe(false);
});

test('sweepStatus records the last reconcile outcome (issue #351 wave 4)', async () => {
  const { custody } = makeCustody(null);
  expect(custody.sweepStatus()).toEqual({
    lastCompletedAt: null,
    lastAttemptedAt: null,
    lastError: null,
    consecutiveFailures: 0,
  });
  await custody.reconcile(new Set());
  const ok = custody.sweepStatus();
  expect(ok.lastCompletedAt).toBeTruthy();
  expect(ok.lastAttemptedAt).toBeTruthy();
  expect(ok.lastError).toBeNull();
  expect(ok.consecutiveFailures).toBe(0);
});

test('sweepStatus counts consecutive failures, then clears on the next success', async () => {
  let broken = true;
  const custody = new BlobCustody(new MemoryBlobStore(), () => ({
    store: {
      kind: 'fake',
      list: () => (broken ? Promise.reject(new Error('remote unreachable')) : Promise.resolve([])),
      get: () => Promise.resolve(null),
      has: () => Promise.resolve(false),
      put: () => Promise.resolve(),
      delete: () => Promise.resolve(),
      stat: () => Promise.resolve(null),
    },
  }));
  await expect(custody.reconcile(new Set())).rejects.toThrow('remote unreachable');
  await expect(custody.reconcile(new Set())).rejects.toThrow('remote unreachable');
  const failed = custody.sweepStatus();
  expect(failed.lastError).toBe('remote unreachable');
  expect(failed.lastCompletedAt).toBeNull(); // never succeeded yet
  expect(failed.consecutiveFailures).toBe(2);

  broken = false;
  await custody.reconcile(new Set());
  const recovered = custody.sweepStatus();
  expect(recovered.lastError).toBeNull();
  expect(recovered.lastCompletedAt).toBeTruthy();
  expect(recovered.consecutiveFailures).toBe(0);
});

test('encrypted remote tier stores ciphertext; open() fetches, verifies, re-caches', async () => {
  const key = Buffer.alloc(32, 9);
  const remoteStore = new MemoryBlobStore();
  const { custody, local } = makeCustody({ store: remoteStore, encryptKey: key });
  const bytes = Buffer.from('cloud-held photo bytes');
  const sha = custody.ingestSync(bytes).sha256;
  await custody.replicate();
  const remoteRaw = remoteStore.getSync(sha)!;
  expect(remoteRaw.equals(bytes)).toBe(false); // ciphertext at rest remotely
  // Simulate a fresh device: local tier lost the bytes.
  local.deleteSync(sha);
  const opened = await custody.open(sha);
  expect(opened?.equals(bytes)).toBe(true);
  expect(local.hasSync(sha)).toBe(true); // re-cached
});

test('exportTo writes a self-contained blobs directory', () => {
  const { custody } = makeCustody(null);
  const sha = custody.ingestSync(Buffer.from('take me home')).sha256;
  const dest = path.join(tmp, 'export');
  expect(custody.exportTo(dest)).toEqual({ copied: 1 });
  const reread = new FsBlobStore(path.join(dest, 'blobs'));
  expect(reread.getSync(sha)?.toString()).toBe('take me home');
});

// ---------- the S3 driver against a fake S3-compatible endpoint ----------

interface FakeS3 {
  url: string;
  objects: Map<string, Buffer>;
  authHeaders: string[];
  close(): Promise<void>;
}

function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const authHeaders: string[] = [];
  const server = http.createServer((req, res) => {
    authHeaders.push(String(req.headers.authorization ?? ''));
    const url = new URL(req.url ?? '/', 'http://s3.local');
    const key = decodeURIComponent(url.pathname).replace(/^\/test-bucket\/?/, '');
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (req.method === 'PUT') {
        objects.set(key, body);
        res.writeHead(200).end();
      } else if (req.method === 'HEAD') {
        const found = objects.get(key);
        if (!found) return void res.writeHead(404).end();
        res.writeHead(200, { 'content-length': String(found.length) }).end();
      } else if (req.method === 'GET' && key === '') {
        // ListObjectsV2 (no pagination in the fake).
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(
          `<ListBucketResult>${keys.map((k) => `<Key>${k}</Key>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
      } else if (req.method === 'GET') {
        const found = objects.get(key);
        if (!found) return void res.writeHead(404).end();
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d+)-(\d*)/.exec(range)!;
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : found.length - 1;
          res.writeHead(206).end(found.subarray(start, end + 1));
        } else {
          res.writeHead(200).end(found);
        }
      } else if (req.method === 'DELETE') {
        objects.delete(key);
        res.writeHead(204).end();
      } else {
        res.writeHead(400).end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        objects,
        authHeaders,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      });
    });
  });
}

test('s3 driver: put/get/has/list/delete against a fake endpoint, SigV4 signed', async () => {
  const fake = await startFakeS3();
  try {
    const store = new S3BlobStore({
      endpoint: fake.url,
      bucket: 'test-bucket',
      prefix: 'vaults/v1',
      credentials: () => Promise.resolve({ accessKeyId: 'AK', secretAccessKey: 'SK' }),
    });
    const bytes = Buffer.from('bucket bytes');
    const sha = sha256OfBytes(bytes);
    await store.put(sha, bytes);
    expect(fake.objects.get(`vaults/v1/blobs/sha256/${sha}`)?.equals(bytes)).toBe(true);
    expect(await store.has(sha)).toBe(true);
    expect((await store.get(sha))?.equals(bytes)).toBe(true);
    expect((await store.get(sha, { start: 7 }))?.toString()).toBe('bytes');
    expect(await store.list()).toEqual([sha]);
    await store.delete(sha);
    expect(await store.has(sha)).toBe(false);
    expect(await store.get(sha)).toBeNull();
    // Every request carried a SigV4 Authorization header.
    expect(fake.authHeaders.length).toBeGreaterThan(0);
    for (const h of fake.authHeaders) {
      expect(h).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\//);
    }
  } finally {
    await fake.close();
  }
});

test('s3 driver: throttleBytesPerSec paces sustained PUT throughput (issue #367 §C7)', async () => {
  const fake = await startFakeS3();
  try {
    // A tight budget relative to the payload: each put is ~1/4 of the whole
    // per-second budget, so 8 sequential puts (2 seconds of bytes) must take
    // meaningfully longer than an unthrottled run of the same puts.
    const bytes = Buffer.alloc(4096, 7);
    const rate = bytes.length * 4; // 4 puts/sec worth of budget

    const throttled = new S3BlobStore({
      endpoint: fake.url,
      bucket: 'test-bucket',
      prefix: 'throttled',
      credentials: () => Promise.resolve({ accessKeyId: 'AK', secretAccessKey: 'SK' }),
      throttleBytesPerSec: rate,
    });
    const unthrottled = new S3BlobStore({
      endpoint: fake.url,
      bucket: 'test-bucket',
      prefix: 'unthrottled',
      credentials: () => Promise.resolve({ accessKeyId: 'AK', secretAccessKey: 'SK' }),
    });

    const puts = 8;
    const startUnthrottled = Date.now();
    for (let i = 0; i < puts; i++) {
      await unthrottled.put(sha256OfBytes(Buffer.concat([bytes, Buffer.from([i])])), bytes);
    }
    const unthrottledMs = Date.now() - startUnthrottled;

    const startThrottled = Date.now();
    for (let i = 0; i < puts; i++) {
      await throttled.put(sha256OfBytes(Buffer.concat([bytes, Buffer.from([i, 1])])), bytes);
    }
    const throttledMs = Date.now() - startThrottled;

    // 8 puts at 4 puts/sec worth of budget should take roughly ~1.75s of
    // waiting (the bucket starts full, so the first ~4 are free) — assert
    // it's clearly slower than the unthrottled run, generously bounded to
    // avoid flaking on a loaded CI box.
    expect(throttledMs).toBeGreaterThan(unthrottledMs + 500);
  } finally {
    await fake.close();
  }
});
