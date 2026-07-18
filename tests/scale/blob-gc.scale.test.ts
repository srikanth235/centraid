import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { BlobCache } from '../../packages/vault/src/blob/cache.js';
import {
  BlobCustody,
  custodyStateCounts,
  refreshCustodyState,
  type CustodyState,
} from '../../packages/vault/src/blob/custody.js';
import { MemoryBlobStore } from '../../packages/vault/src/blob/local.js';
import { blobUriFor, sha256OfBytes } from '../../packages/vault/src/blob/store.js';
import { openVaultDb } from '../../packages/vault/src/db.js';
import { expect, onTestFinished, test } from 'vitest';

const OWNER = 'tests/scale/blob-gc.scale.test.ts';
const STATES: readonly CustodyState[] = [
  'replicated',
  'local-only',
  'pending-offsite',
  'remote-only',
  'missing',
];

test('large mixed-custody CAS evicts only remotely proven, non-staged local bytes', async () => {
  const db = openVaultDb();
  await db.blobTransfers.close();
  onTestFinished(() => db.close());

  const remote = new MemoryBlobStore();
  const local = new MemoryBlobStore();
  const budget = { bytes: Number.MAX_SAFE_INTEGER };
  const cache = new BlobCache(db.vault, local, {
    settings: () => ({ budgetBytes: budget.bytes }),
  });
  const custody = new BlobCustody(local, () => ({ store: remote }), cache);
  const shasByState = new Map(STATES.map((state) => [state, [] as string[]]));
  const count = 10_000;
  const perState = count / STATES.length;
  let protectedLocalBytes = 0;

  const content = db.vault.prepare(
    `INSERT INTO core_content_item
       (content_id, media_type, content_uri, sha256, byte_size, created_at)
     VALUES (?, 'application/octet-stream', ?, ?, ?, ?)`,
  );
  const outbox = db.vault.prepare(
    `INSERT INTO blob_outbox (sha256, byte_size, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();

  db.vault.exec('BEGIN');
  try {
    for (let index = 0; index < count; index += 1) {
      const state = STATES[index % STATES.length];
      const bytes = Buffer.from(`scale-blob-${index.toString().padStart(5, '0')}`);
      const sha = sha256OfBytes(bytes);
      shasByState.get(state)!.push(sha);
      content.run(`scale-content-${index}`, blobUriFor(sha), sha, bytes.length, now);

      if (state === 'replicated' || state === 'local-only' || state === 'pending-offsite') {
        local.putSync(sha, bytes);
      }
      if (state === 'replicated' || state === 'pending-offsite' || state === 'remote-only') {
        remote.putSync(sha, bytes);
        cache.replica.mark(sha, bytes.length);
      }
      if (state === 'local-only' || state === 'pending-offsite') {
        protectedLocalBytes += bytes.length;
      }
      if (state === 'pending-offsite') {
        outbox.run(sha, bytes.length, now, now);
      }
    }
    db.vault.exec('COMMIT');
  } catch (error) {
    db.vault.exec('ROLLBACK');
    throw error;
  }

  const started = performance.now();
  await refreshCustodyState({ ...db, blobs: custody });
  const before = custodyStateCounts(db.vault);
  expect(before).toEqual(Object.fromEntries(STATES.map((state) => [state, perState])));

  // Heal durable replica evidence from the large remote inventory before the
  // explicitly authorized post-reconciliation eviction pass. Pending blobs
  // deliberately model the post-promotion state: their staging rows are gone,
  // but the durable outbox obligation remains. The new budget keeps exactly
  // the local-only and pending-offsite bytes.
  cache.replica.heal('cas', new Set(await remote.list()), (sha) => local.statSync(sha)?.size ?? 0);
  budget.bytes = protectedLocalBytes;
  const evicted = custody.evictAfterReconcile();
  const durationMs = performance.now() - started;

  const eligible = shasByState.get('replicated')!;
  const localOnly = shasByState.get('local-only')!;
  const pending = shasByState.get('pending-offsite')!;
  const passed =
    evicted.evictedBlobs === perState &&
    eligible.every((sha) => !local.hasSync(sha) && remote.hasSync(sha)) &&
    localOnly.every((sha) => local.hasSync(sha)) &&
    pending.every((sha) => local.hasSync(sha));
  await recordQualityResult({
    lane: 'scale',
    owner: OWNER,
    name: 'Mixed-custody CAS eviction at 10k objects',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'wall clock', value: durationMs, unit: 'ms', budget: 30_000 },
      { name: 'objects scanned', value: count, unit: 'objects' },
      { name: 'objects evicted', value: evicted.evictedBlobs, unit: 'objects' },
    ],
  });

  expect(evicted.evictedBlobs).toBe(perState);
  expect(evicted.evictedBytes).toBeGreaterThan(0);
  expect(eligible.every((sha) => !local.hasSync(sha) && remote.hasSync(sha))).toBe(true);
  expect(localOnly.every((sha) => local.hasSync(sha))).toBe(true);
  expect(pending.every((sha) => local.hasSync(sha))).toBe(true);
  expect(shasByState.get('remote-only')!.every((sha) => !local.hasSync(sha))).toBe(true);
  expect(shasByState.get('missing')!.every((sha) => !local.hasSync(sha))).toBe(true);
});
