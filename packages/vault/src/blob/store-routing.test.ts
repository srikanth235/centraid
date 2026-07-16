// Blob replication store-class routing (issue #425 Wave 2 Part A). Against a
// `derived`-capable target every replicated thumb/preview/poster must land under
// the derived prefix and NO derivative object under the cas prefix; the original
// lands under cas. Against a non-capable target (no derivedPrefix) behavior is
// unchanged — everything under cas. Also covers the read path (an evicted
// derivative reads through from the derived prefix) and the ReplicaIndex store
// column. Exercised against an in-process fake S3 endpoint (real HTTP, SigV4).

import http from 'node:http';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openVaultDb, type VaultDb } from '../db.js';
import { ensureVaultBootstrapped, updateBlobStoreSettings } from '../host.js';
import { BLOB_CACHE_DDL } from '../schema/blob.js';
import { ReplicaIndex } from './replica-index.js';
import { stageBlobBytes } from './staging.js';

interface FakeS3 {
  url: string;
  objects: Map<string, Buffer>;
  requests: { method: string; key: string }[];
  close(): Promise<void>;
}

function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const requests: { method: string; key: string }[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://s3.local');
    const key = decodeURIComponent(url.pathname).replace(/^\/test-bucket\/?/, '');
    requests.push({ method: req.method ?? '', key });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const q = url.searchParams;
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
        const prefix = q.get('prefix') ?? '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
        res.writeHead(200, { 'content-type': 'application/xml' });
        return void res.end(
          `<ListBucketResult>${keys
            .map((k) => `<Key>${k}</Key>`)
            .join('')}<IsTruncated>false</IsTruncated></ListBucketResult>`,
        );
      }
      if (req.method === 'GET') {
        const found = objects.get(key);
        if (!found) return void res.writeHead(404).end();
        const range = req.headers.range;
        if (typeof range === 'string') {
          const m = /bytes=(\d+)-(\d*)/.exec(range);
          const start = Number(m?.[1] ?? 0);
          const end = m?.[2] ? Number(m[2]) : found.length - 1;
          return void res.writeHead(206).end(found.subarray(start, end + 1));
        }
        return void res.writeHead(200).end(found);
      }
      res.writeHead(400).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        objects,
        requests,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      });
    });
  });
}

const CREDS = () => Promise.resolve({ accessKeyId: 'AK', secretAccessKey: 'SK' });
const CAS_PREFIX = 'u/acct/cas';
const DERIVED_PREFIX = 'u/acct/derived';

let fake: FakeS3;
beforeEach(async () => {
  fake = await startFakeS3();
});
afterEach(async () => {
  await fake.close();
});

/** Stage an original plus its three binary derivatives (distinct byte identities). */
function stageOriginalWithDerivatives(db: VaultDb): {
  original: string;
  thumb: string;
  preview: string;
  poster: string;
} {
  const original = stageBlobBytes(db, {
    bytes: Buffer.from('original-image-bytes-000'),
    filename: 'photo.png',
  }).sha256;
  const derivative = (variant: 'thumb' | 'preview' | 'poster', bytes: string): string =>
    stageBlobBytes(db, { bytes: Buffer.from(bytes), variant, variantOf: original }).sha256;
  return {
    original,
    thumb: derivative('thumb', 'thumb-bytes-aaa'),
    preview: derivative('preview', 'preview-bytes-bbb'),
    poster: derivative('poster', 'poster-bytes-ccc'),
  };
}

function casKey(sha: string): string {
  return `${CAS_PREFIX}/blobs/sha256/${sha}`;
}
function derivedKey(sha: string): string {
  return `${DERIVED_PREFIX}/blobs/sha256/${sha}`;
}

test('derived-capable target: every derivative lands under the derived prefix, none under cas', async () => {
  const db = openVaultDb({ s3Credentials: CREDS });
  try {
    ensureVaultBootstrapped(db, { ownerName: 'Routing Owner' });
    updateBlobStoreSettings(db, {
      blob_store: {
        kind: 's3',
        endpoint: fake.url,
        bucket: 'test-bucket',
        prefix: CAS_PREFIX,
        derivedPrefix: DERIVED_PREFIX,
      },
    });
    const shas = stageOriginalWithDerivatives(db);
    const moved = await db.blobs.replicate();
    expect(moved.sort()).toEqual([shas.original, shas.thumb, shas.preview, shas.poster].sort());

    // Original under cas; every derivative under derived and NOT under cas.
    expect(fake.objects.has(casKey(shas.original))).toBe(true);
    expect(fake.objects.has(derivedKey(shas.original))).toBe(false);
    for (const sha of [shas.thumb, shas.preview, shas.poster]) {
      expect(fake.objects.has(derivedKey(sha))).toBe(true);
      expect(fake.objects.has(casKey(sha))).toBe(false);
    }

    // No object under the cas prefix is a derivative; none under derived is the original.
    const casShas = [...fake.objects.keys()]
      .filter((k) => k.startsWith(`${CAS_PREFIX}/`))
      .map((k) => k.slice(casKey('').length));
    expect(casShas).toEqual([shas.original]);
    const derivedShas = [...fake.objects.keys()]
      .filter((k) => k.startsWith(`${DERIVED_PREFIX}/`))
      .map((k) => k.slice(derivedKey('').length));
    expect(derivedShas.sort()).toEqual([shas.thumb, shas.preview, shas.poster].sort());

    // The replica index records WHERE each sha actually landed.
    const stores = new Map(
      (
        db.vault.prepare('SELECT sha256, store FROM blob_replica').all() as {
          sha256: string;
          store: string;
        }[]
      ).map((r) => [r.sha256, r.store]),
    );
    expect(stores.get(shas.original)).toBe('cas');
    expect(stores.get(shas.thumb)).toBe('derived');
    expect(stores.get(shas.preview)).toBe('derived');
    expect(stores.get(shas.poster)).toBe('derived');
  } finally {
    db.close();
  }
});

test('an evicted derivative reads back through the derived prefix', async () => {
  const db = openVaultDb({ s3Credentials: CREDS });
  try {
    ensureVaultBootstrapped(db, { ownerName: 'Read Owner' });
    updateBlobStoreSettings(db, {
      blob_store: {
        kind: 's3',
        endpoint: fake.url,
        bucket: 'test-bucket',
        prefix: CAS_PREFIX,
        derivedPrefix: DERIVED_PREFIX,
      },
    });
    const shas = stageOriginalWithDerivatives(db);
    await db.blobs.replicate();

    // Drop the local preview copy; the derived remote copy holds.
    db.blobs.deleteLocalSync(shas.preview);
    expect(db.blobs.hasSync(shas.preview)).toBe(false);
    const before = fake.requests.filter(
      (r) => r.method === 'GET' && r.key === derivedKey(shas.preview),
    ).length;

    const bytes = await db.blobs.open(shas.preview);
    expect(bytes?.toString()).toBe('preview-bytes-bbb');
    // The read-through fetched from the DERIVED prefix, never cas.
    const after = fake.requests.filter(
      (r) => r.method === 'GET' && r.key === derivedKey(shas.preview),
    ).length;
    expect(after).toBeGreaterThan(before);
    expect(fake.requests.some((r) => r.method === 'GET' && r.key === casKey(shas.preview))).toBe(
      false,
    );
  } finally {
    db.close();
  }
});

test('non-capable target (no derivedPrefix): behavior unchanged, everything under cas', async () => {
  const db = openVaultDb({ s3Credentials: CREDS });
  try {
    ensureVaultBootstrapped(db, { ownerName: 'Legacy Owner' });
    updateBlobStoreSettings(db, {
      blob_store: { kind: 's3', endpoint: fake.url, bucket: 'test-bucket', prefix: CAS_PREFIX },
    });
    const shas = stageOriginalWithDerivatives(db);
    await db.blobs.replicate();

    for (const sha of [shas.original, shas.thumb, shas.preview, shas.poster]) {
      expect(fake.objects.has(casKey(sha))).toBe(true);
      expect(fake.objects.has(derivedKey(sha))).toBe(false);
    }
    const stores = (
      db.vault.prepare('SELECT store FROM blob_replica').all() as { store: string }[]
    ).map((r) => r.store);
    expect(stores).toEqual(['cas', 'cas', 'cas', 'cas']);
  } finally {
    db.close();
  }
});

// ---------- ReplicaIndex store-column unit coverage ----------

function memIndex(): ReplicaIndex {
  const db = new DatabaseSync(':memory:');
  db.exec(BLOB_CACHE_DDL);
  return new ReplicaIndex(db);
}

const SHA = (n: number): string => n.toString(16).padStart(64, '0');

test('ReplicaIndex: mark defaults to cas and storeOf reflects the recorded class', () => {
  const index = memIndex();
  index.mark(SHA(1), 10);
  index.mark(SHA(2), 20, 'derived');
  expect(index.storeOf(SHA(1))).toBe('cas');
  expect(index.storeOf(SHA(2))).toBe('derived');
  expect(index.storeOf(SHA(3))).toBeUndefined();
  expect(index.all('cas')).toEqual(new Set([SHA(1)]));
  expect(index.all('derived')).toEqual(new Set([SHA(2)]));
  expect(index.all()).toEqual(new Set([SHA(1), SHA(2)]));
  expect(index.rows().find((r) => r.sha256 === SHA(2))?.store).toBe('derived');
});

test('ReplicaIndex.heal is per-store: a derived listing never heals away cas evidence', () => {
  const index = memIndex();
  index.mark(SHA(1), 10, 'cas');
  index.mark(SHA(2), 20, 'derived');
  // The derived store lost SHA(2); its listing is empty.
  index.heal('derived', new Set(), () => 0);
  expect(index.storeOf(SHA(2))).toBeUndefined();
  // cas evidence is untouched by the derived heal.
  expect(index.storeOf(SHA(1))).toBe('cas');
  // A cas listing adds a new cas row without disturbing derived rows.
  index.mark(SHA(2), 20, 'derived');
  index.heal('cas', new Set([SHA(1), SHA(3)]), () => 5);
  expect(index.storeOf(SHA(3))).toBe('cas');
  expect(index.storeOf(SHA(2))).toBe('derived');
});
