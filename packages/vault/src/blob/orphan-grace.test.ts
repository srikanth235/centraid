// Orphan-grace GC invariant (issue #439 R4). Two halves: the OrphanTombstoneIndex
// (first-observed-orphaned bookkeeping) and reconcileCustody's grace gate — a
// genuine orphan is HELD for the recovery window N before the client-owned CAS
// delete may evict it, so a PITR that lands between two snapshots can still reach
// a blob referenced by no retained manifest.

import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { BLOB_CACHE_DDL } from '../schema/blob.js';
import { reconcileCustody, type ReconcileContext } from './custody-reconcile.js';
import { MemoryBlobStore } from './local.js';
import { OrphanTombstoneIndex } from './orphan-tombstone.js';
import { sha256OfBytes } from './store.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA = (s: string): string => sha256OfBytes(Buffer.from(s));

function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(BLOB_CACHE_DDL);
  return db;
}

// ---------- OrphanTombstoneIndex ----------

test('markFirstSeen stamps once and is idempotent — the grace clock never resets', () => {
  const orphans = new OrphanTombstoneIndex(memDb());
  const sha = SHA('a');
  expect(orphans.read(sha)).toBeUndefined();
  expect(orphans.markFirstSeen(sha, 1000)).toBe(1000);
  // A later observation keeps the ORIGINAL stamp (INSERT OR IGNORE).
  expect(orphans.markFirstSeen(sha, 9999)).toBe(1000);
  expect(orphans.read(sha)).toBe(1000);
});

test('clear forgets the tombstone so a re-orphaned sha gets a fresh stamp', () => {
  const orphans = new OrphanTombstoneIndex(memDb());
  const sha = SHA('b');
  orphans.markFirstSeen(sha, 1000);
  orphans.clear(sha);
  expect(orphans.read(sha)).toBeUndefined();
  expect(orphans.markFirstSeen(sha, 5000)).toBe(5000);
});

// ---------- reconcileCustody grace gate ----------

interface Harness {
  ctx: ReconcileContext;
  remote: MemoryBlobStore;
  orphans: OrphanTombstoneIndex;
}

function harness(): Harness {
  const remote = new MemoryBlobStore();
  const local = new MemoryBlobStore();
  const orphans = new OrphanTombstoneIndex(memDb());
  const ctx: ReconcileContext = {
    remote: { store: remote },
    local,
    orphans,
    desiredStore: () => 'cas',
    open: () => Promise.resolve(),
    replicate: (shas) => Promise.resolve(shas),
  };
  return { ctx, remote, orphans };
}

test('a freshly-found orphan is tombstoned and HELD, not deleted', async () => {
  const { ctx, remote, orphans } = harness();
  const orphan = SHA('short-lived');
  remote.putSync(orphan, Buffer.from('short-lived'));

  const result = await reconcileCustody(ctx, new Set(), {
    graceWindowMs: 3 * DAY_MS,
    now: () => 1_000,
  });

  expect(result.orphansGraceHeld).toEqual([orphan]);
  expect(result.orphansDeleted).toEqual([]);
  expect(remote.hasSync(orphan)).toBe(true); // survived — grace not yet elapsed
  expect(orphans.read(orphan)).toBe(1_000); // first-observed stamp recorded
});

test('an orphan whose tombstone is older than the grace window is deleted', async () => {
  const { ctx, remote, orphans } = harness();
  const orphan = SHA('aged');
  remote.putSync(orphan, Buffer.from('aged'));
  orphans.markFirstSeen(orphan, 0); // observed orphaned at t=0

  const result = await reconcileCustody(ctx, new Set(), {
    graceWindowMs: 3 * DAY_MS,
    now: () => 3 * DAY_MS + 1, // strictly past the window
  });

  expect(result.orphansDeleted).toEqual([orphan]);
  expect(result.orphansGraceHeld).toEqual([]);
  expect(remote.hasSync(orphan)).toBe(false);
  expect(orphans.read(orphan)).toBeUndefined(); // tombstone cleared on delete
});

test('an orphan still inside the grace window is held, not deleted', async () => {
  const { ctx, remote } = harness();
  const orphan = SHA('recent');
  remote.putSync(orphan, Buffer.from('recent'));
  ctx.orphans!.markFirstSeen(orphan, 0);

  const result = await reconcileCustody(ctx, new Set(), {
    graceWindowMs: 3 * DAY_MS,
    now: () => 3 * DAY_MS, // exactly at the window — NOT strictly past, so held
  });

  expect(result.orphansGraceHeld).toEqual([orphan]);
  expect(result.orphansDeleted).toEqual([]);
  expect(remote.hasSync(orphan)).toBe(true);
});

test('a sha that becomes live again clears its tombstone and is never deleted', async () => {
  const { ctx, remote, orphans } = harness();
  const sha = SHA('re-referenced');
  remote.putSync(sha, Buffer.from('re-referenced'));
  orphans.markFirstSeen(sha, 0); // it WAS orphaned on a prior sweep

  const result = await reconcileCustody(ctx, new Set([sha]), {
    graceWindowMs: 3 * DAY_MS,
    now: () => 100 * DAY_MS, // even long past the window, a LIVE sha never deletes
  });

  expect(result.orphansDeleted).toEqual([]);
  expect(result.orphansGraceHeld).toEqual([]);
  expect(remote.hasSync(sha)).toBe(true);
  expect(orphans.read(sha)).toBeUndefined(); // tombstone cleared — no longer orphaned
});

test('a snapshot-root-pinned orphan is never deleted AND never tombstoned', async () => {
  const { ctx, remote, orphans } = harness();
  const pinned = SHA('recovery-window byte');
  remote.putSync(pinned, Buffer.from('recovery-window byte'));

  const result = await reconcileCustody(ctx, new Set(), {
    graceWindowMs: 3 * DAY_MS,
    now: () => 1_000,
    extraLiveRoots: new Set([pinned]),
  });

  expect(result.orphansDeleted).toEqual([]);
  expect(result.orphansGraceHeld).toEqual([]); // pinned ⇒ not an orphan at all
  expect(remote.hasSync(pinned)).toBe(true);
  expect(orphans.read(pinned)).toBeUndefined(); // no spurious tombstone churn
});

test('grace window requested but no tombstone store ⇒ fail-safe hold', async () => {
  const remote = new MemoryBlobStore();
  const orphan = SHA('no-store');
  remote.putSync(orphan, Buffer.from('no-store'));
  const ctx: ReconcileContext = {
    remote: { store: remote },
    local: new MemoryBlobStore(),
    // orphans deliberately absent
    desiredStore: () => 'cas',
    open: () => Promise.resolve(),
    replicate: (shas) => Promise.resolve(shas),
  };

  const result = await reconcileCustody(ctx, new Set(), { graceWindowMs: 3 * DAY_MS });

  expect(result.orphansGraceHeld).toEqual([orphan]);
  expect(result.orphansDeleted).toEqual([]);
  expect(remote.hasSync(orphan)).toBe(true);
});

test('no grace window ⇒ pre-R4 immediate delete (local-only vault has no window)', async () => {
  const { ctx, remote } = harness();
  const orphan = SHA('legacy');
  remote.putSync(orphan, Buffer.from('legacy'));

  const result = await reconcileCustody(ctx, new Set(), {}); // graceWindowMs undefined

  expect(result.orphansDeleted).toEqual([orphan]);
  expect(result.orphansGraceHeld).toEqual([]);
  expect(remote.hasSync(orphan)).toBe(false);
});

test('an infinite grace window (fail-safe) holds every orphan forever', async () => {
  const { ctx, remote } = harness();
  const orphan = SHA('protected');
  remote.putSync(orphan, Buffer.from('protected'));

  const result = await reconcileCustody(ctx, new Set(), {
    graceWindowMs: Number.POSITIVE_INFINITY,
    now: () => 1_000_000 * DAY_MS,
  });

  expect(result.orphansGraceHeld).toEqual([orphan]);
  expect(result.orphansDeleted).toEqual([]);
  expect(remote.hasSync(orphan)).toBe(true);
});
