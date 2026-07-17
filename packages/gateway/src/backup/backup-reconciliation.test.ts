import { expect, test, vi } from 'vitest';
import {
  walGroupCloserKey,
  walPairMarkerKey,
  walSegmentKey,
  type SnapshotRow,
} from '@centraid/backup';
import {
  reconcileCasInventory,
  snapshotInventorySummary,
  walCoverageFromInventory,
  walInventoryGaps,
} from './backup-reconciliation.js';

const GEN = 'a'.repeat(32);
const JOURNAL_GEN = 'b'.repeat(32);
const PRESENT = '1'.repeat(64);
const MISSING = '2'.repeat(64);
const ORPHAN = '3'.repeat(64);

test('missing remote CAS evidence is demoted synchronously and orphans are report-only', () => {
  const unmark = vi.fn();
  const state = reconcileCasInventory({
    collection: {
      source: 'provider',
      providerAttested: true,
      objects: [PRESENT, ORPHAN].map((sha) => ({
        key: `blobs/sha256/${sha}`,
        sizeBytes: 10,
        etagOrHash: sha,
        storedAt: 1,
        state: 'live' as const,
      })),
    },
    live: new Set([PRESENT, MISSING]),
    indexed: new Set([PRESENT, MISSING]),
    unmark,
  });
  expect(unmark).toHaveBeenCalledExactlyOnceWith(MISSING);
  expect(state.missing).toEqual({ count: 1, sample: [MISSING] });
  expect(state.orphans).toEqual({ count: 1, sample: [ORPHAN] });
});

test('a retained-snapshot-referenced blob present remotely is live, not an orphan (issue #436 §6)', () => {
  const unmark = vi.fn();
  // ORPHAN here is referenced ONLY by a retained snapshot — absent from the live
  // vault model and the replica index — yet present in the remote CAS listing.
  const state = reconcileCasInventory({
    collection: {
      source: 'provider',
      providerAttested: true,
      objects: [ORPHAN].map((sha) => ({
        key: `blobs/sha256/${sha}`,
        sizeBytes: 10,
        etagOrHash: sha,
        storedAt: 1,
        state: 'live' as const,
      })),
    },
    live: new Set<string>(),
    indexed: new Set<string>(),
    unmark,
    snapshotReferenced: new Set([ORPHAN]),
  });
  expect(state.orphans).toEqual({ count: 0, sample: [] });
  expect(state.missing).toEqual({ count: 0, sample: [] });
  expect(unmark).not.toHaveBeenCalled();
});

test('a retained-snapshot-referenced blob ABSENT remotely is a critical missing finding (issue #436 §6)', () => {
  const unmark = vi.fn();
  // MISSING is named by a retained snapshot but the remote CAS no longer holds
  // it: the recovery window is broken for that attachment ⇒ critical `missing`.
  const state = reconcileCasInventory({
    collection: { source: 'provider', providerAttested: true, objects: [] },
    live: new Set<string>(),
    indexed: new Set<string>(),
    unmark,
    snapshotReferenced: new Set([MISSING]),
  });
  expect(state.missing).toEqual({ count: 1, sample: [MISSING] });
  // Pure snapshot roots have no index row, so nothing is demoted.
  expect(unmark).not.toHaveBeenCalled();
});

test('WAL inventory detects a gap before a provider closer', () => {
  const keys = [
    walSegmentKey({
      db: 'vault',
      generation: GEN,
      group: 0,
      startOffset: 0,
      endOffset: 100,
      tickMs: 1,
    }),
    walSegmentKey({
      db: 'vault',
      generation: GEN,
      group: 0,
      startOffset: 120,
      endOffset: 200,
      tickMs: 2,
    }),
    walGroupCloserKey({ db: 'vault', generation: GEN, group: 0, endOffset: 200 }),
  ];
  expect(walInventoryGaps(keys, new Set([GEN]))).toContain(`vault/${GEN}/group-0: 100-120`);
});

test('a contiguous WAL inventory through its closer is clean', () => {
  const keys = [
    walSegmentKey({
      db: 'journal',
      generation: GEN,
      group: 0,
      startOffset: 0,
      endOffset: 100,
      tickMs: 1,
    }),
    walGroupCloserKey({ db: 'journal', generation: GEN, group: 0, endOffset: 100 }),
  ];
  expect(walInventoryGaps(keys, new Set([GEN]))).toEqual([]);
});

test('WAL coverage reports the bounded PITR span from anchored objects only', () => {
  const day = 24 * 60 * 60 * 1000;
  const keys = [
    walSegmentKey({
      db: 'vault',
      generation: GEN,
      group: 0,
      startOffset: 0,
      endOffset: 100,
      tickMs: day,
    }),
    walPairMarkerKey({
      vaultGeneration: GEN,
      journalGeneration: JOURNAL_GEN,
      tickMs: 3 * day,
    }),
    walSegmentKey({
      db: 'vault',
      generation: 'c'.repeat(32),
      group: 0,
      startOffset: 0,
      endOffset: 100,
      tickMs: 10 * day,
    }),
  ];
  expect(walCoverageFromInventory(keys, new Set([GEN, JOURNAL_GEN]))).toEqual({
    earliestTickMs: day,
    latestTickMs: 3 * day,
    spanDays: 2,
    segmentCount: 1,
    markerCount: 1,
  });
});

test('snapshot transparency is newest-first, bounded, and retains prune/size/format facts', () => {
  const rows: SnapshotRow[] = Array.from({ length: 55 }, (_, index) => {
    const seq = index + 1;
    return {
      seq,
      manifestKey: `manifests/${seq}.json`,
      manifestHash: String(seq).padStart(64, '0'),
      prevManifestHash: null,
      totalBytes: seq * 100,
      objectCount: seq,
      generation: 1,
      format: 'centraid-snapshot/2',
      appMeta: {},
      createdAt: seq,
      prunedAt: seq % 2 === 0 ? seq + 100 : null,
    };
  });
  const summary = snapshotInventorySummary(rows);
  expect(summary).toMatchObject({ live: 28, pruned: 27 });
  expect(summary.recent).toHaveLength(50);
  expect(summary.recent[0]).toEqual({
    seq: 55,
    totalBytes: 5500,
    objectCount: 55,
    createdAt: 55,
    prunedAt: null,
    format: 'centraid-snapshot/2',
  });
  expect(summary.recent.at(-1)?.seq).toBe(6);
});
