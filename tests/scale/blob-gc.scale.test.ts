import { recordQualityResult } from '@centraid/test-kit/quality-result';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { BlobCache } from '../../packages/vault/src/blob/cache.js';
import {
  BlobCustody,
  custodyStateCounts,
  refreshCustodyState,
  type CustodyState,
} from '../../packages/vault/src/blob/custody.js';
import { FsBlobStore, MemoryBlobStore } from '../../packages/vault/src/blob/local.js';
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
  // The local tier is the real filesystem-backed CAS the vault ships in
  // production (FsBlobStore), so eviction actually deletes bytes off disk and
  // the has/stat checks below hit real files — not an in-memory map for both
  // tiers. Remote stays in-memory (it stands in for offsite object storage).
  const local = new FsBlobStore(await tempDir('blob-gc-local-'));
  const budget = { bytes: Number.MAX_SAFE_INTEGER };
  const cache = new BlobCache(db.vault, local, {
    settings: () => ({ budgetBytes: budget.bytes }),
  });
  const custody = new BlobCustody(local, () => ({ store: remote }), cache);
  const shasByState = new Map(STATES.map((state) => [state, [] as string[]]));
  // 5k objects (3k of them resident on the real FsBlobStore). The custody scan +
  // eviction — the thing under test — is measured separately below and stays
  // sub-second; the bound here keeps fixture seeding (one fsync per real CAS
  // file) comfortably inside the nightly scale timeout on slow CI disks.
  const count = 5_000;
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
      const state = STATES[index % STATES.length]!;
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
  // Data-loss guard (the fix this cell protects): a blob whose staging row is
  // gone but which still has a durable blob_outbox obligation is UNEVICTABLE
  // even though the remote already holds a copy. Assert both the on-disk bytes
  // survived AND the outbox rows are intact after the eviction pass.
  const outboxRemaining = (
    db.vault.prepare('SELECT count(*) AS n FROM blob_outbox').get() as { n: number }
  ).n;
  const DURATION_BUDGET_MS = 30_000;
  const passed =
    evicted.evictedBlobs === perState &&
    eligible.every((sha) => !local.hasSync(sha) && remote.hasSync(sha)) &&
    localOnly.every((sha) => local.hasSync(sha)) &&
    pending.every((sha) => local.hasSync(sha)) &&
    outboxRemaining === perState &&
    durationMs < DURATION_BUDGET_MS;
  await recordQualityResult({
    lane: 'scale',
    owner: OWNER,
    name: 'Mixed-custody CAS eviction at 5k objects',
    status: passed ? 'passed' : 'failed',
    measurements: [
      { name: 'wall clock', value: durationMs, unit: 'ms', budget: DURATION_BUDGET_MS },
      { name: 'objects scanned', value: count, unit: 'objects' },
      { name: 'objects evicted', value: evicted.evictedBlobs, unit: 'objects' },
    ],
  });

  expect(evicted.evictedBlobs).toBe(perState);
  expect(evicted.evictedBytes).toBeGreaterThan(0);
  expect(eligible.every((sha) => !local.hasSync(sha) && remote.hasSync(sha))).toBe(true);
  expect(localOnly.every((sha) => local.hasSync(sha))).toBe(true);
  // Pending-outbox bytes must remain on local disk — evicting them is the
  // silent data loss this guard exists to catch.
  expect(pending.every((sha) => local.hasSync(sha))).toBe(true);
  expect(outboxRemaining).toBe(perState);
  expect(shasByState.get('remote-only')!.every((sha) => !local.hasSync(sha))).toBe(true);
  expect(shasByState.get('missing')!.every((sha) => !local.hasSync(sha))).toBe(true);
  expect(durationMs).toBeLessThan(DURATION_BUDGET_MS);
});
