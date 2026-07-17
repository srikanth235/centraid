/*
 * `VaultPlane`'s blob-sweep scheduling (issue #367 §C5/§C6/§C9): the
 * failure-backoff decision (pure function, unit tests) plus a real S3-backed
 * integration covering lease-gated reconciliation and post-restart
 * resumability. Uses the same committed `S3TestServer` the storage-e2e
 * suite (`../backup/storage-e2e.test.ts`) does — no mocked fetch.
 */

import { afterAll, describe, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { S3TestServer } from '@centraid/backup/dist/testing/s3-test-server.js';
import { blobUriFor, updateBlobStoreSettings, uuidv7 } from '@centraid/vault';
import { blobSweepBackoff, openVaultPlane, type VaultPlane } from './vault-plane.js';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `vault-plane-sweep-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function startServer(): Promise<S3TestServer> {
  const server = await S3TestServer.start();
  cleanups.push(() => server.close());
  return server;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('blobSweepBackoff (pure)', () => {
  test('no failures yet — never skips', () => {
    expect(blobSweepBackoff({ consecutiveFailures: 0, lastAttemptedAt: null }, Date.now())).toEqual(
      {
        skip: false,
        retryInMs: 0,
      },
    );
  });

  test('one failure, just attempted — skips, retry window > 0', () => {
    const now = Date.now();
    const result = blobSweepBackoff(
      { consecutiveFailures: 1, lastAttemptedAt: new Date(now).toISOString() },
      now,
    );
    expect(result.skip).toBe(true);
    expect(result.retryInMs).toBeGreaterThan(0);
  });

  test('one failure, long enough ago — proceeds', () => {
    const now = Date.now();
    const longAgo = new Date(now - 10 * 60_000).toISOString(); // 10 minutes ago
    expect(blobSweepBackoff({ consecutiveFailures: 1, lastAttemptedAt: longAgo }, now).skip).toBe(
      false,
    );
  });

  test('many consecutive failures cap at the max backoff window, not unbounded growth', () => {
    const now = Date.now();
    // 100 failures would be a huge linear window uncapped — assert it's
    // capped at 30 minutes (BLOB_SWEEP_MAX_BACKOFF_MS), not ~100 minutes.
    const recentEnough = new Date(now - 31 * 60_000).toISOString(); // 31 minutes ago
    expect(
      blobSweepBackoff({ consecutiveFailures: 100, lastAttemptedAt: recentEnough }, now).skip,
    ).toBe(false);
  });
});

describe('VaultPlane blob sweep — real S3, lease gate + resumability', () => {
  function openPlane(
    dir: string,
    opts: { endpoint: string; leaseConflicted: () => boolean },
  ): VaultPlane {
    const plane = openVaultPlane({
      dir,
      logger: silentLogger,
      ownerName: 'Priya',
      sweepIntervalMs: 25, // fast tick for the test
      leaseConflicted: opts.leaseConflicted,
      s3Credentials: async () => ({ accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret_test' }),
    });
    updateBlobStoreSettings(plane.db, {
      blob_store: {
        kind: 's3',
        endpoint: opts.endpoint,
        region: 'us-east-1',
        bucket: 'b',
        prefix: 'p',
      },
    });
    cleanups.push(() => plane.stop());
    return plane;
  }

  test('lease conflict pauses orphan-delete; clearing it resumes and finishes the job', async () => {
    const server = await startServer();
    const dir = await tempDir();
    let conflicted = true;
    const plane = openPlane(dir, { endpoint: server.url, leaseConflicted: () => conflicted });

    const orphanSha = crypto.createHash('sha256').update('lease-orphan').digest('hex');
    server.putObjectDirect('b', `p/blobs/sha256/${orphanSha}`, Buffer.from('orphan'));

    plane.start();
    // Give the sweep clock a few ticks while conflicted — the orphan must survive.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.hasObjectDirect('b', `p/blobs/sha256/${orphanSha}`)).toBe(true);

    conflicted = false;
    await until(() => !server.hasObjectDirect('b', `p/blobs/sha256/${orphanSha}`), 3000);
  });

  test('sweep is resumable after a restart — a fresh VaultPlane over the same dir picks the backlog straight back up', async () => {
    const server = await startServer();
    const dir = await tempDir();
    const plane1 = openPlane(dir, { endpoint: server.url, leaseConflicted: () => false });

    // Ingest local bytes but stop BEFORE the sweep clock (25ms) has a chance
    // to replicate them — proves the backlog survives as on-disk custody
    // state, not as in-memory sweep progress. A `core_content_item` row is
    // what makes a sha "live" for `liveBlobShas()` — the sweep's ground
    // truth for what SHOULD be replicated, not merely what the local CAS holds.
    const bytes = Buffer.from('resumable content');
    const { sha256: sha, byteSize } = plane1.db.blobs.ingestSync(bytes);
    plane1.db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES (?, 'application/octet-stream', ?, ?, ?, datetime('now'))`,
      )
      .run(uuidv7(), blobUriFor(sha), sha, byteSize);
    plane1.stop();
    expect(await makeS3List(server)).not.toContain(sha);

    // A brand-new VaultPlane instance (simulating a gateway restart) over
    // the SAME directory: nothing in-process carried over, only the files.
    const plane2 = openPlane(dir, { endpoint: server.url, leaseConflicted: () => false });
    plane2.start();
    await until(async () => (await makeS3List(server)).includes(sha), 3000);
    expect(plane2.db.blobs.hasSync(sha)).toBe(true);
  });

  test('a retained-snapshot GC root survives the sweep; a genuine orphan does not (issue #436 §6)', async () => {
    const server = await startServer();
    const dir = await tempDir();
    const plane = openPlane(dir, { endpoint: server.url, leaseConflicted: () => false });

    const pinnedSha = crypto.createHash('sha256').update('snapshot-referenced').digest('hex');
    const straySha = crypto.createHash('sha256').update('true-orphan').digest('hex');
    server.putObjectDirect('b', `p/blobs/sha256/${pinnedSha}`, Buffer.from('pin'));
    server.putObjectDirect('b', `p/blobs/sha256/${straySha}`, Buffer.from('stray'));
    // The gateway (BackupService) supplies retained-snapshot roots; here we
    // stand in for it directly on the plane.
    plane.snapshotBlobRoots = async () => new Set([pinnedSha]);

    plane.start();
    // The stray orphan must be swept; the pinned root must never be.
    await until(() => !server.hasObjectDirect('b', `p/blobs/sha256/${straySha}`), 3000);
    expect(server.hasObjectDirect('b', `p/blobs/sha256/${pinnedSha}`)).toBe(true);
  });

  test('when the snapshot-roots supplier throws, orphan-delete fails safe — nothing is deleted (issue #436 §6)', async () => {
    const server = await startServer();
    const dir = await tempDir();
    const plane = openPlane(dir, { endpoint: server.url, leaseConflicted: () => false });

    const orphanSha = crypto.createHash('sha256').update('unprovable-reachability').digest('hex');
    server.putObjectDirect('b', `p/blobs/sha256/${orphanSha}`, Buffer.from('orphan'));
    // Reachability cannot be established (e.g. an unreadable manifest) — the
    // sweep must NOT delete, because it cannot prove the object is unreferenced.
    plane.snapshotBlobRoots = async () => {
      throw new Error('cannot read manifest');
    };

    plane.start();
    // Let several sweep ticks (25ms) elapse; the orphan must persist.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(server.hasObjectDirect('b', `p/blobs/sha256/${orphanSha}`)).toBe(true);
  });
});

async function makeS3List(server: S3TestServer): Promise<string[]> {
  const { S3BlobStore } = await import('@centraid/vault');
  const s3 = new S3BlobStore({
    endpoint: server.url,
    bucket: 'b',
    region: 'us-east-1',
    prefix: 'p',
    credentials: async () => ({ accessKeyId: 'AKIA_TEST', secretAccessKey: 'secret_test' }),
  });
  return s3.list();
}
