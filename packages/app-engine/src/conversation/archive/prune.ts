// Phase-B custody-gated prune (issue #438 decision 3). For each archive row not
// yet pruned, the raw turns in its seq-range delete ONLY when the segment's
// custody is proven — the delete lives behind the `custodyProven` latch in this
// one code path, so prune-before-custody is structurally impossible. Items and
// attachment rows CASCADE off `turns`; the digest already carries the range's
// rollups, so Insights/Executions are unaffected.

import type { DatabaseSync } from 'node:sqlite';
import type { CustodyProven } from './types.js';

interface PendingArchiveRow {
  id: string;
  conversation_id: string;
  seq_from: number;
  seq_to: number;
  segment_sha256: string;
}

/**
 * Reclaim pages the prune deletes freed. Mirrors the vault's
 * `journal-archive.ts` reclaimSpace: journal.db is opened with
 * `auto_vacuum=INCREMENTAL` (#438 wave 1, both openers), so `incremental_vacuum`
 * is the normal path — it returns the freelist to the OS without rewriting the
 * whole file. The full VACUUM fallback covers a legacy file not yet converted.
 * Runs at most once per prune pass, never inline with a live write, and only
 * when there is anything to reclaim (`freelist_count > 0`).
 */
export function reclaimJournalPages(journal: DatabaseSync): {
  mode: 'incremental' | 'full' | 'none';
  ranVacuum: boolean;
} {
  const freelist = (journal.prepare('PRAGMA freelist_count').get() as { freelist_count: number })
    .freelist_count;
  const av = (journal.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }).auto_vacuum;
  const mode = av === 2 ? 'incremental' : av === 1 ? 'full' : 'none';
  if (freelist === 0) return { mode, ranVacuum: false };
  if (mode === 'incremental') {
    journal.exec('PRAGMA incremental_vacuum');
    return { mode, ranVacuum: true };
  }
  journal.exec('VACUUM');
  return { mode: 'full', ranVacuum: true };
}

/**
 * Prune the raw rows of every custody-proven archive segment, bounded by
 * `maxSegments`. Each segment is one transaction: delete its turns (items +
 * attachments CASCADE), then latch `pruned_at`. `conversations.turn_count` is a
 * LIFETIME counter (bumped in noteTurn, never decremented — the existing
 * automation retention prune leaves it too), so it is deliberately untouched:
 * decrementing would make it disagree with every other post-delete path.
 * Returns the turns deleted and segments latched.
 */
export function pruneCustodyProven(
  journal: DatabaseSync,
  custodyProven: CustodyProven,
  nowMs: number,
  maxSegments: number,
): { turnsPruned: number; segmentsPruned: number } {
  const pending = journal
    .prepare(
      `SELECT id, conversation_id, seq_from, seq_to, segment_sha256
         FROM conversation_archive
        WHERE pruned_at IS NULL
        ORDER BY created_at ASC
        LIMIT ?`,
    )
    .all(maxSegments) as unknown as PendingArchiveRow[];

  let turnsPruned = 0;
  let segmentsPruned = 0;
  for (const row of pending) {
    // THE LATCH. No delete path exists outside this branch.
    if (!custodyProven(row.segment_sha256)) continue;
    journal.exec('BEGIN IMMEDIATE');
    try {
      const info = journal
        .prepare(`DELETE FROM turns WHERE conversation_id = ? AND seq BETWEEN ? AND ?`)
        .run(row.conversation_id, row.seq_from, row.seq_to);
      journal
        .prepare(`UPDATE conversation_archive SET pruned_at = ? WHERE id = ?`)
        .run(nowMs, row.id);
      journal.exec('COMMIT');
      turnsPruned += Number(info.changes);
      segmentsPruned += 1;
    } catch (err) {
      journal.exec('ROLLBACK');
      throw err;
    }
  }
  return { turnsPruned, segmentsPruned };
}
