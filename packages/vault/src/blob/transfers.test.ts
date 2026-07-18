import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { readBackupPolicy } from '../backup-policy.js';
import { bootstrapVault } from '../bootstrap.js';
import { openVaultDb, type VaultDb } from '../db.js';
import { BlobCache } from './cache.js';
import { BlobContentKeyRegistry } from './content-keys.js';
import type { RemoteTier } from './custody-types.js';
import { stageFallbackIngress } from './fallback-finalize.js';
import { FsBlobStore } from './local.js';
import { unsealBlob } from './seal.js';
import type { BlobRange, BlobStat, BlobStore } from './store.js';
import { BlobTransferCoordinator, INGRESS_FSYNC_BATCH_BYTES } from './transfers.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface FallbackRun {
  db: VaultDb;
  local: FsBlobStore;
  cache: BlobCache;
  coordinator: BlobTransferCoordinator;
}

function fallbackRestartHarness(prefix: string): {
  restart(): Promise<FallbackRun>;
} {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  let current: FallbackRun | null = null;
  let initialized = false;
  const closeCurrent = async (): Promise<void> => {
    if (!current) return;
    await current.coordinator.close();
    current.db.close();
    current = null;
  };
  cleanups.push(async () => {
    await closeCurrent();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    async restart() {
      await closeCurrent();
      const db = openVaultDb({ dir });
      await db.blobTransfers.close();
      if (!initialized) {
        bootstrapVault(db, { ownerName: 'Priya' });
        initialized = true;
      }
      const local = new FsBlobStore(path.join(dir, 'blobs'));
      const cache = new BlobCache(db.vault, local, {
        qosCooldownMs: 0,
        settings: () => ({ budgetBytes: Number.MAX_SAFE_INTEGER }),
      });
      const coordinator = new BlobTransferCoordinator({
        vault: db.vault,
        dir,
        local,
        cache,
        remote: () => null,
        remoteConfigured: () => true,
        policy: () => readBackupPolicy(db.vault),
        contentKeys: new BlobContentKeyRegistry(db.vault, db.sealKey),
        drainIntervalMs: 60_000,
      });
      current = { db, local, cache, coordinator };
      return current;
    },
  };
}

function stagingCount(db: VaultDb, sha256: string): number {
  return (
    db.vault
      .prepare('SELECT COUNT(*) AS count FROM blob_staging WHERE sha256 = ? AND variant IS NULL')
      .get(sha256) as { count: number }
  ).count;
}

function ranged(bytes: Buffer, range?: BlobRange): Buffer {
  if (!range) return Buffer.from(bytes);
  return Buffer.from(bytes.subarray(range.start, (range.end ?? bytes.length - 1) + 1));
}

test('fallback ingress persists offsets once per 4 MiB durability batch (#456 I7)', async () => {
  const h = fallbackRestartHarness('blob-fallback-fsync-batch-');
  const run = await h.restart();
  const begin = await run.coordinator.beginIngress({});
  expect(begin.mode).toBe('spool');
  if (begin.mode !== 'spool') throw new Error('expected spool ingress');

  const first = Buffer.alloc(1024, 1);
  await run.coordinator.appendIngress(begin.sessionId, 0, first);
  expect(run.coordinator.state.session(begin.sessionId)?.received_bytes).toBe(0);

  const remainder = Buffer.alloc(INGRESS_FSYNC_BATCH_BYTES - first.length, 2);
  await run.coordinator.appendIngress(begin.sessionId, first.length, remainder);
  expect(run.coordinator.state.session(begin.sessionId)).toMatchObject({
    received_bytes: INGRESS_FSYNC_BATCH_BYTES,
    hash_state_json: null,
  });
});

test('restart commit truncates a non-durable tail before adopting unknown-size ingress', async () => {
  const h = fallbackRestartHarness('blob-fallback-truncate-tail-');
  const first = await h.restart();
  const begin = await first.coordinator.beginIngress({ resumable: true });
  expect(begin.mode).toBe('spool');
  if (begin.mode !== 'spool') throw new Error('expected spool ingress');
  const durable = Buffer.from('durable prefix');
  const nonDurableTail = Buffer.from('tail that survived close but not the offset transaction');
  const tempPath = first.coordinator.state.session(begin.sessionId)?.temp_path;
  if (!tempPath) throw new Error('expected fallback temp path');
  // Model the crash boundary directly: SQLite contains only the last fsynced
  // offset while the filesystem still exposes later, non-durable bytes.
  writeFileSync(tempPath, Buffer.concat([durable, nonDurableTail]));
  first.coordinator.state.recordAppend(begin.sessionId, durable.length);
  expect(first.coordinator.state.session(begin.sessionId)?.received_bytes).toBe(durable.length);
  first.coordinator.abandon();

  const second = await h.restart();
  const committed = await second.coordinator.commitIngress(begin.sessionId);
  const expectedSha = createHash('sha256').update(durable).digest('hex');
  expect(committed).toMatchObject({ sha256: expectedSha, byteSize: durable.length });
  expect(second.local.getSync(expectedSha)).toEqual(durable);
});

test('strict acknowledgment returns a durable pending receipt while provider is down, then transitions', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'blob-strict-pending-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const db: VaultDb = openVaultDb({ dir });
  cleanups.push(() => db.close());
  await db.blobTransfers.close();
  bootstrapVault(db, { ownerName: 'Priya' });
  const local = new FsBlobStore(path.join(dir, 'blobs'));
  const cache = new BlobCache(db.vault, local, {
    qosCooldownMs: 0,
    settings: () => ({ budgetBytes: Number.MAX_SAFE_INTEGER }),
  });
  const keys = new BlobContentKeyRegistry(db.vault, db.sealKey);
  const objects = new Map<string, Buffer>();
  let available = false;
  let rejectOffline!: (reason: Error) => void;
  const offlinePut = new Promise<void>((_resolve, reject) => {
    rejectOffline = reject;
  });
  const store: BlobStore = {
    kind: 'strict-fake',
    put: async (sha, bytes) => {
      if (!available) return offlinePut;
      objects.set(sha, Buffer.from(bytes));
    },
    get: async (sha, range) => {
      const bytes = objects.get(sha);
      return bytes ? ranged(bytes, range) : null;
    },
    has: async (sha) => objects.has(sha),
    delete: async (sha) => {
      objects.delete(sha);
    },
    list: async () => [...objects.keys()],
    stat: async (sha): Promise<BlobStat | null> => {
      const bytes = objects.get(sha);
      return bytes ? { size: bytes.length } : null;
    },
  };
  const remote: RemoteTier = { store, keyFor: (sha) => keys.getOrCreate(sha), frameSize: 32 };
  const coordinator = new BlobTransferCoordinator({
    vault: db.vault,
    dir,
    local,
    cache,
    remote: () => remote,
    remoteConfigured: () => true,
    policy: () => ({ ...readBackupPolicy(db.vault), casAck: 'replicated' }),
    contentKeys: keys,
    drainIntervalMs: 60_000,
  });
  cleanups.push(() => coordinator.close());
  const statuses: string[] = [];
  coordinator.subscribe((status) =>
    statuses.push(`${status.pendingCount}:${status.lastError ?? ''}`),
  );
  const plain = Buffer.from('strict is an event gate, not a blocking socket');
  const begin = await coordinator.beginIngress({ expectedSize: plain.length });
  expect(begin.mode).toBe('spool');
  if (begin.mode !== 'spool') throw new Error('expected spool ingress');
  coordinator.appendIngress(begin.sessionId, 0, plain);
  const committed = await coordinator.commitIngress(begin.sessionId);
  expect(committed).toMatchObject({ casAck: 'replicated', custody: 'pending-offsite' });
  expect(local.hasSync(committed.sha256)).toBe(true);
  expect(coordinator.state.outbox(committed.sha256)).not.toBeNull();

  rejectOffline(new Error('provider offline'));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(coordinator.state.outbox(committed.sha256)?.last_error).toContain('provider offline');

  available = true;
  coordinator.recordLocalReceipt(committed.sha256, plain.length);
  await coordinator.close();
  expect((await coordinator.preflight(committed.sha256)).custody).toBe('replicated');
  expect(
    unsealBlob(
      keys.getOrCreate(committed.sha256),
      committed.sha256,
      objects.get(committed.sha256)!,
    ).equals(plain),
  ).toBe(true);
  expect(statuses.some((value) => value.startsWith('1:'))).toBe(true);
  expect(statuses.at(-1)).toBe('0:');
});

test('fallback commit resumes after restart from committing before temp adoption', async () => {
  const h = fallbackRestartHarness('blob-fallback-before-adopt-');
  const plain = Buffer.from('GIF89a fallback commit survives the first crash boundary');
  const sha = createHash('sha256').update(plain).digest('hex');
  const first = await h.restart();
  const begin = await first.coordinator.beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
    resumable: true,
  });
  expect(begin.mode).toBe('spool');
  if (begin.mode !== 'spool') throw new Error('expected spool ingress');
  await first.coordinator.appendIngress(begin.sessionId, 0, plain);

  // Crash boundary: the irreversible phase is durable, but the temp file has
  // not moved under its content address yet.
  first.coordinator.state.setSessionState(begin.sessionId, 'committing');

  const second = await h.restart();
  const resumed = await second.coordinator.beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
    resumable: true,
  });
  expect(resumed).toMatchObject({
    mode: 'spool',
    sessionId: begin.sessionId,
    offset: plain.length,
  });
  const committed = await second.coordinator.commitIngress(begin.sessionId);
  expect(committed).toMatchObject({ sha256: sha, custody: 'pending-offsite' });
  expect(second.local.getSync(sha)).toEqual(plain);
  expect(second.coordinator.state.session(begin.sessionId)).toMatchObject({
    state: 'complete',
    expected_sha256: sha,
  });
  expect(second.coordinator.state.outbox(sha)).not.toBeNull();
  expect(stagingCount(second.db, sha)).toBe(1);

  // A lost response is another replay, not another claim or custody row. The
  // sniffed type must also survive the completed-response reconstruction.
  const replay = await second.coordinator.commitIngress(begin.sessionId);
  expect(replay).toMatchObject({ sha256: sha, mediaType: committed.mediaType });
  expect(stagingCount(second.db, sha)).toBe(1);
  expect(
    second.db.vault.prepare('SELECT COUNT(*) AS count FROM blob_outbox WHERE sha256 = ?').get(sha),
  ).toEqual({ count: 1 });
});

test('fallback commit resumes after restart when adoption removed the temp file', async () => {
  const h = fallbackRestartHarness('blob-fallback-after-adopt-');
  const plain = Buffer.from('unknown hash is recovered entirely from the persisted digest state');
  const sha = createHash('sha256').update(plain).digest('hex');
  const firstRun = await h.restart();
  const begin = await firstRun.coordinator.beginIngress({ expectedSize: plain.length });
  expect(begin.mode).toBe('spool');
  if (begin.mode !== 'spool') throw new Error('expected spool ingress');
  await firstRun.coordinator.appendIngress(begin.sessionId, 0, plain);
  const committing = firstRun.coordinator.state.beginFallbackCommit(begin.sessionId, sha);
  expect(committing.temp_path).not.toBeNull();
  expect(firstRun.local.adoptTempSync?.(sha, committing.temp_path!)).toBe(true);
  firstRun.cache.onPut(plain.length);
  expect(existsSync(committing.temp_path!)).toBe(false);

  const second = await h.restart();
  const committed = await second.coordinator.commitIngress(begin.sessionId);
  expect(committed).toMatchObject({ sha256: sha, custody: 'pending-offsite' });
  expect(second.local.getSync(sha)).toEqual(plain);
  expect(second.coordinator.state.session(begin.sessionId)?.state).toBe('complete');
  expect(second.coordinator.state.outbox(sha)).not.toBeNull();
  expect(stagingCount(second.db, sha)).toBe(1);
});

test('fallback commit replay keeps staged and enqueued finalize steps idempotent', async () => {
  const h = fallbackRestartHarness('blob-fallback-after-enqueue-');
  const plain = Buffer.from('staging and custody enqueue may both precede a process crash');
  const sha = createHash('sha256').update(plain).digest('hex');
  const firstRun = await h.restart();
  const begin = await firstRun.coordinator.beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
    resumable: true,
  });
  expect(begin.mode).toBe('spool');
  if (begin.mode !== 'spool') throw new Error('expected spool ingress');
  await firstRun.coordinator.appendIngress(begin.sessionId, 0, plain);
  const row = firstRun.coordinator.state.beginFallbackCommit(begin.sessionId, sha);
  expect(firstRun.local.adoptTempSync?.(sha, row.temp_path!)).toBe(true);
  firstRun.cache.onPut(plain.length);
  stageFallbackIngress({ vault: firstRun.db.vault, local: firstRun.local, row, sha256: sha });
  firstRun.coordinator.state.enqueue(sha, plain.length);
  expect(firstRun.coordinator.state.session(begin.sessionId)?.state).toBe('committing');

  const second = await h.restart();
  const committed = await second.coordinator.commitIngress(begin.sessionId);
  expect(committed).toMatchObject({ sha256: sha, custody: 'pending-offsite' });
  expect(second.coordinator.state.session(begin.sessionId)?.state).toBe('complete');
  expect(stagingCount(second.db, sha)).toBe(1);
  expect(
    second.db.vault.prepare('SELECT COUNT(*) AS count FROM blob_outbox WHERE sha256 = ?').get(sha),
  ).toEqual({ count: 1 });
});

test('completed fallback replay repairs the former crash window before outbox enqueue', async () => {
  const h = fallbackRestartHarness('blob-fallback-complete-before-enqueue-');
  const plain = Buffer.from('complete must never mean the remote custody obligation was forgotten');
  const sha = createHash('sha256').update(plain).digest('hex');
  const firstRun = await h.restart();
  const begin = await firstRun.coordinator.beginIngress({
    expectedSha256: sha,
    expectedSize: plain.length,
    resumable: true,
  });
  expect(begin.mode).toBe('spool');
  if (begin.mode !== 'spool') throw new Error('expected spool ingress');
  await firstRun.coordinator.appendIngress(begin.sessionId, 0, plain);
  const row = firstRun.coordinator.state.beginFallbackCommit(begin.sessionId, sha);
  expect(firstRun.local.adoptTempSync?.(sha, row.temp_path!)).toBe(true);
  firstRun.cache.onPut(plain.length);
  stageFallbackIngress({ vault: firstRun.db.vault, local: firstRun.local, row, sha256: sha });
  // This is the exact ordering used before the fix: complete was durable, but
  // the process died before recordLocalReceipt could create the outbox row.
  firstRun.coordinator.state.completeSession(begin.sessionId, sha);
  expect(firstRun.coordinator.state.outbox(sha)).toBeNull();

  const second = await h.restart();
  const replay = await second.coordinator.commitIngress(begin.sessionId);
  expect(replay).toMatchObject({ sha256: sha, custody: 'pending-offsite' });
  expect(second.coordinator.state.outbox(sha)).not.toBeNull();
  expect(second.coordinator.state.session(begin.sessionId)?.state).toBe('complete');
  expect(stagingCount(second.db, sha)).toBe(1);
});
