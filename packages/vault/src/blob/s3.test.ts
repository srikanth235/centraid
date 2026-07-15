// S3 driver units for issue #405 §6 (storage class) and §4 (retry/backoff),
// exercised against an in-process fake S3 endpoint (real HTTP, SigV4-signed
// requests, no SDK). The fake here is a superset of blob.test.ts's private
// `startFakeS3` — it also speaks multipart, captures the `x-amz-storage-class`
// header + the Authorization line per request, and can be told to fail the
// next N requests with a chosen status so the retry matrix is observable.

import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { MULTIPART_THRESHOLD_BYTES, S3BlobStore } from './s3.js';
import { sha256OfBytes } from './store.js';
import { openVaultDb } from '../db.js';
import { ensureVaultBootstrapped, updateBlobStoreSettings } from '../host.js';

// ---------- the fake S3 endpoint ----------

interface FakeRequest {
  method: string;
  key: string;
  search: string;
  storageClass: string | null;
  authorization: string;
}

interface FakeS3 {
  url: string;
  objects: Map<string, Buffer>;
  requests: FakeRequest[];
  /** Answer the next `failNext` requests with `failStatus` before behaving normally. */
  failNext: number;
  failStatus: number;
  close(): Promise<void>;
}

/** The signed-headers list embedded in an `Authorization: AWS4-HMAC-SHA256 …` line. */
function signedHeadersOf(authorization: string): string[] {
  const m = /SignedHeaders=([^,]+)/.exec(authorization);
  return m ? (m[1] ?? '').split(';') : [];
}

function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const requests: FakeRequest[] = [];
  const state = { failNext: 0, failStatus: 503 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://s3.local');
    const key = decodeURIComponent(url.pathname).replace(/^\/test-bucket\/?/, '');
    requests.push({
      method: req.method ?? '',
      key,
      search: url.search,
      storageClass:
        typeof req.headers['x-amz-storage-class'] === 'string'
          ? (req.headers['x-amz-storage-class'] as string)
          : null,
      authorization: String(req.headers.authorization ?? ''),
    });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      // Injected transient faults (issue #405 §4) take precedence over the
      // real behavior so the driver's retry loop is what's under test.
      if (state.failNext > 0) {
        state.failNext -= 1;
        return void res.writeHead(state.failStatus).end('injected failure');
      }
      const body = Buffer.concat(chunks);
      const q = url.searchParams;
      if (req.method === 'POST' && q.has('uploads')) {
        // CreateMultipartUpload — the storage class rides HERE (§6).
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          '<InitiateMultipartUploadResult><UploadId>fake-upload-1</UploadId></InitiateMultipartUploadResult>',
        );
      }
      if (req.method === 'POST' && q.has('uploadId')) {
        // CompleteMultipartUpload.
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
      }
      if (req.method === 'PUT' && q.has('uploadId')) {
        // UploadPart — never carries the storage class.
        return void res.writeHead(200, { etag: `"etag-${q.get('partNumber')}"` }).end();
      }
      if (req.method === 'PUT') {
        objects.set(key, body);
        return void res.writeHead(200).end();
      }
      if (req.method === 'HEAD') {
        const found = objects.get(key);
        if (!found) return void res.writeHead(404).end();
        return void res.writeHead(200, { 'content-length': String(found.length) }).end();
      }
      if (req.method === 'DELETE') {
        objects.delete(key);
        return void res.writeHead(204).end();
      }
      if (req.method === 'GET' && key === '') {
        // ListObjectsV2 (no pagination in the fake).
        const prefix = q.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          `<ListBucketResult>${keys.map((k) => `<Key>${k}</Key>`).join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
      }
      if (req.method === 'GET') {
        const found = objects.get(key);
        if (!found) return void res.writeHead(404).end();
        return void res.writeHead(200).end(found);
      }
      res.writeHead(400).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const fake: FakeS3 = {
        url: `http://127.0.0.1:${addr.port}`,
        objects,
        requests,
        get failNext() {
          return state.failNext;
        },
        set failNext(n: number) {
          state.failNext = n;
        },
        get failStatus() {
          return state.failStatus;
        },
        set failStatus(s: number) {
          state.failStatus = s;
        },
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
      resolve(fake);
    });
  });
}

const CREDS = () => Promise.resolve({ accessKeyId: 'AK', secretAccessKey: 'SK' });
/** Retries with no real waiting — the schedule is jittered, tests must not sleep. */
const NO_SLEEP = () => Promise.resolve();

let fake: FakeS3;
beforeEach(async () => {
  fake = await startFakeS3();
});
afterEach(async () => {
  await fake.close();
});

// ---------- issue #405 §6: storage class ----------

test('storage class: PUT carries a signed x-amz-storage-class when configured', async () => {
  const store = new S3BlobStore({
    endpoint: fake.url,
    bucket: 'test-bucket',
    credentials: CREDS,
    storageClass: 'GLACIER',
  });
  const bytes = Buffer.from('cold bytes');
  await store.put(sha256OfBytes(bytes), bytes);

  const put = fake.requests.find((r) => r.method === 'PUT');
  expect(put?.storageClass).toBe('GLACIER');
  // The header is not merely present — it is part of the SigV4 signature, so
  // a proxy that dropped it would break the signature (issue #405 §6 accept).
  expect(signedHeadersOf(put!.authorization)).toContain('x-amz-storage-class');
});

test("storage class: unset ⇒ no header ⇒ today's behavior (byte-for-byte)", async () => {
  const store = new S3BlobStore({ endpoint: fake.url, bucket: 'test-bucket', credentials: CREDS });
  const bytes = Buffer.from('warm bytes');
  await store.put(sha256OfBytes(bytes), bytes);

  const put = fake.requests.find((r) => r.method === 'PUT');
  expect(put?.storageClass).toBeNull();
  expect(signedHeadersOf(put!.authorization)).not.toContain('x-amz-storage-class');
});

test('storage class: multipart CREATE carries it, UploadPart does not (§6)', async () => {
  const store = new S3BlobStore({
    endpoint: fake.url,
    bucket: 'test-bucket',
    credentials: CREDS,
    storageClass: 'STANDARD_IA',
  });
  // Force the multipart path: bigger than the single-PUT threshold, streamed
  // lazily so we never hold the whole (>32 MiB) blob at once.
  const partish = Buffer.alloc(12 * 1024 * 1024, 3);
  const total = MULTIPART_THRESHOLD_BYTES + partish.length; // > threshold ⇒ multipart
  const source = Readable.from([partish, partish, partish, partish]); // 48 MiB ⇒ 3 parts
  await store.putStream('a'.repeat(64), source, total);

  const create = fake.requests.find((r) => r.method === 'POST' && r.search.includes('uploads'));
  expect(create?.storageClass).toBe('STANDARD_IA');
  const parts = fake.requests.filter((r) => r.method === 'PUT' && r.search.includes('uploadId'));
  expect(parts.length).toBeGreaterThanOrEqual(2);
  for (const part of parts) expect(part.storageClass).toBeNull();
});

// ---------- issue #405 §4: retry / backoff ----------

test('retry: two 503s then 200 ⇒ the PUT succeeds after exactly 3 requests', async () => {
  fake.failNext = 2;
  fake.failStatus = 503;
  const store = new S3BlobStore({
    endpoint: fake.url,
    bucket: 'test-bucket',
    credentials: CREDS,
    sleepImpl: NO_SLEEP,
  });
  const bytes = Buffer.from('flaky upload');
  await store.put(sha256OfBytes(bytes), bytes);
  expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(3);
});

test('retry: a 400 is definitive — no retry, the op throws on the first answer', async () => {
  fake.failNext = 1;
  fake.failStatus = 400;
  const store = new S3BlobStore({
    endpoint: fake.url,
    bucket: 'test-bucket',
    credentials: CREDS,
    sleepImpl: NO_SLEEP,
  });
  const bytes = Buffer.from('rejected upload');
  await expect(store.put(sha256OfBytes(bytes), bytes)).rejects.toThrow(/s3 put .*: 400/);
  expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
});

test('retry: a 429 is retried like a 5xx', async () => {
  fake.failNext = 1;
  fake.failStatus = 429;
  const store = new S3BlobStore({
    endpoint: fake.url,
    bucket: 'test-bucket',
    credentials: CREDS,
    sleepImpl: NO_SLEEP,
  });
  const bytes = Buffer.from('throttled upload');
  await store.put(sha256OfBytes(bytes), bytes);
  expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(2);
});

test('retry: a thrown fetch/network error is retried, then succeeds', async () => {
  let attempts = 0;
  const flakyFetch: typeof fetch = (input, init) => {
    attempts += 1;
    // First attempt never reaches the server (simulated socket refusal); the
    // retry delegates to the real fetch against the fake endpoint.
    if (attempts === 1) return Promise.reject(new Error('ECONNREFUSED 127.0.0.1'));
    return fetch(input, init);
  };
  const store = new S3BlobStore({
    endpoint: fake.url,
    bucket: 'test-bucket',
    credentials: CREDS,
    fetchImpl: flakyFetch,
    sleepImpl: NO_SLEEP,
  });
  const bytes = Buffer.from('dropped socket');
  await store.put(sha256OfBytes(bytes), bytes);
  expect(attempts).toBe(2);
  // Only the second (successful) attempt ever reached the server.
  expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
});

test('retry: exhausting all attempts on 5xx surfaces the final status', async () => {
  fake.failNext = 3; // default attempts total = 3 ⇒ never succeeds
  fake.failStatus = 500;
  const store = new S3BlobStore({
    endpoint: fake.url,
    bucket: 'test-bucket',
    credentials: CREDS,
    sleepImpl: NO_SLEEP,
  });
  const bytes = Buffer.from('down for good');
  await expect(store.put(sha256OfBytes(bytes), bytes)).rejects.toThrow(/s3 put .*: 500/);
  expect(fake.requests.filter((r) => r.method === 'PUT')).toHaveLength(3);
});

// ---------- settings passthrough: blob_store.storageClass → remoteTier → driver ----------

test('settings: storageClass flows through readBlobStoreSettings → remoteTier onto the PUT', async () => {
  const db = openVaultDb({ s3Credentials: CREDS });
  try {
    // A `core_vault` row must exist for the settings UPDATE to land on it.
    ensureVaultBootstrapped(db, { ownerName: 'Cold Storage Owner' });
    updateBlobStoreSettings(db, {
      blob_store: {
        kind: 's3',
        endpoint: fake.url,
        bucket: 'test-bucket',
        encrypt: false,
        storageClass: 'DEEP_ARCHIVE',
      },
    });
    const bytes = Buffer.from('replicate me to cold storage');
    const { sha256 } = db.blobs.ingestSync(bytes);
    const moved = await db.blobs.replicate();
    expect(moved).toContain(sha256);

    const put = fake.requests.find((r) => r.method === 'PUT');
    expect(put?.storageClass).toBe('DEEP_ARCHIVE');
    expect(signedHeadersOf(put!.authorization)).toContain('x-amz-storage-class');
  } finally {
    db.close();
  }
});
