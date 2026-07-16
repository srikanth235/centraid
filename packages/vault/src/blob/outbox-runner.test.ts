import { expect, test } from 'vitest';
import { openVaultDb } from '../db.js';
import { BlobCache } from './cache.js';
import { MemoryBlobStore } from './local.js';
import { BlobOutboxRunner } from './outbox-runner.js';
import { sha256OfBytes } from './store.js';
import { BlobTransferState } from './transfer-state.js';

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
