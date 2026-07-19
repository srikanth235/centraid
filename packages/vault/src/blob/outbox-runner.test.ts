import { afterEach, expect, test, vi } from 'vitest';
import { openVaultDb } from '../db.js';
import { BlobCache } from './cache.js';
import { MemoryBlobStore } from './local.js';
import { BlobOutboxRunner } from './outbox-runner.js';
import { sha256OfBytes } from './store.js';
import { BlobTransferState } from './transfer-state.js';

afterEach(() => vi.useRealTimers());

test('custody drain never exceeds the configured replication concurrency', async () => {
  const db = openVaultDb();
  await db.blobTransfers.close();
  const local = new MemoryBlobStore();
  const remote = new MemoryBlobStore();
  const state = new BlobTransferState(db.vault);
  const cache = new BlobCache(db.vault, local, { replicationConcurrency: 2 });
  for (let index = 0; index < 4; index += 1) {
    const bytes = Buffer.from(`concurrent-outbox-${index}`);
    const sha = sha256OfBytes(bytes);
    local.putSync(sha, bytes);
    state.enqueue(sha, bytes.length);
  }

  let inFlight = 0;
  let maxInFlight = 0;
  let ready!: () => void;
  let release!: () => void;
  const firstWaveReady = new Promise<void>((resolve) => (ready = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const put = remote.put.bind(remote);
  remote.put = async (sha, bytes) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight === 2) ready();
    await gate;
    await put(sha, bytes);
    inFlight -= 1;
  };
  const runner = new BlobOutboxRunner({
    vault: db.vault,
    state,
    local,
    cache,
    remote: () => ({ store: remote }),
    remoteConfigured: () => true,
    onStatus: () => undefined,
    intervalMs: 60_000,
  });

  try {
    const draining = runner.drainDue();
    await firstWaveReady;
    expect(inFlight).toBe(2);
    expect(maxInFlight).toBe(2);
    release();
    await draining;
    expect(maxInFlight).toBe(2);
    expect(state.status().pendingCount).toBe(0);
  } finally {
    release();
    await runner.close();
    db.close();
  }
});

test('an unconfigured remote tier performs no fast polling (#456 I1)', async () => {
  vi.useFakeTimers();
  const db = openVaultDb();
  await db.blobTransfers.close();
  const state = new BlobTransferState(db.vault);
  const due = vi.spyOn(state, 'dueOutbox');
  const runner = new BlobOutboxRunner({
    vault: db.vault,
    state,
    local: new MemoryBlobStore(),
    cache: new BlobCache(db.vault, new MemoryBlobStore()),
    remote: () => null,
    remoteConfigured: () => false,
    onStatus: () => undefined,
  });
  try {
    // The one-minute backstop is jittered ±10% (timer-jitter.ts), so the
    // earliest possible fire is 54s — stay strictly below it.
    await vi.advanceTimersByTimeAsync(53_000);
    expect(due).not.toHaveBeenCalled();
  } finally {
    await runner.close();
    db.close();
  }
});

test('an unconfigured remote still reaps expired local sessions and resources', async () => {
  vi.useFakeTimers();
  const db = openVaultDb();
  await db.blobTransfers.close();
  const state = new BlobTransferState(db.vault);
  state.createSession({
    sessionId: 'expired-local',
    kind: 'fallback',
    tempPath: '/tmp/centraid-expired-local-does-not-exist',
    expiresAt: new Date(0).toISOString(),
  });
  const expired: string[] = [];
  const local = new MemoryBlobStore();
  const runner = new BlobOutboxRunner({
    vault: db.vault,
    state,
    local,
    cache: new BlobCache(db.vault, local),
    remote: () => null,
    remoteConfigured: () => false,
    onExpireSession: (sessionId) => void expired.push(sessionId),
    onStatus: () => undefined,
  });
  try {
    // The backstop is jittered ±10%, so the latest possible fire is 66s —
    // advance past it (65s used to lose the draw ~8% of the time).
    await vi.advanceTimersByTimeAsync(70_000);
    expect(expired).toEqual(['expired-local']);
    expect(state.session('expired-local')).toBeNull();
  } finally {
    await runner.close();
    db.close();
  }
});

test('a pressured host defers timer-driven replication but keeps its durable row', async () => {
  vi.useFakeTimers();
  const db = openVaultDb();
  await db.blobTransfers.close();
  const local = new MemoryBlobStore();
  const remote = new MemoryBlobStore();
  const state = new BlobTransferState(db.vault);
  const bytes = Buffer.from('defer-me');
  const sha = sha256OfBytes(bytes);
  local.putSync(sha, bytes);
  state.enqueue(sha, bytes.length);
  const runner = new BlobOutboxRunner({
    vault: db.vault,
    state,
    local,
    cache: new BlobCache(db.vault, local),
    remote: () => ({ store: remote }),
    remoteConfigured: () => true,
    shouldDeferBackgroundWork: () => true,
    onStatus: () => undefined,
    intervalMs: 1,
  });
  try {
    await vi.advanceTimersByTimeAsync(2);
    expect(state.status().pendingCount).toBe(1);
    expect(await remote.has(sha)).toBe(false);
  } finally {
    await runner.close();
    db.close();
  }
});
