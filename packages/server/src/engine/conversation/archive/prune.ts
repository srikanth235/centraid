// Custody-gated prune (#438): deletes ONLY behind the `custodyProven` latch.

import type { DatabaseSync } from "node:sqlite";

import type { CustodyProven } from "./types.js";

interface PendingArchiveRow {
  id: string;
  conversation_id: string;
  seq_from: number;
  seq_to: number;
  segment_sha256: string;
}

// Reclaims freed pages via `incremental_vacuum` (#438); never a whole-file VACUUM.
export function reclaimJournalPages(journal: DatabaseSync): {
  mode: "incremental" | "none";
  ranVacuum: boolean;
} {
  const freelist = (
    journal.prepare("PRAGMA freelist_count").get() as { freelist_count: number }
  ).freelist_count;
  const av = (
    journal.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number }
  ).auto_vacuum;
  const mode = av === 2 ? "incremental" : "none";
  if (freelist === 0) return { mode, ranVacuum: false };
  if (mode === "incremental") {
    journal.exec("PRAGMA incremental_vacuum");
    return { mode, ranVacuum: true };
  }
  return { mode, ranVacuum: false };
}

// One transaction per segment; `turn_count` is a LIFETIME counter — untouched.
export function pruneCustodyProven(
  journal: DatabaseSync,
  custodyProven: CustodyProven,
  nowMs: number,
  maxSegments: number
): { turnsPruned: number; segmentsPruned: number } {
  const pending = journal
    .prepare(
      `SELECT id, conversation_id, seq_from, seq_to, segment_sha256
         FROM conversation_archive
        WHERE pruned_at IS NULL
        ORDER BY created_at ASC
        LIMIT ?`
    )
    .all(maxSegments) as unknown as PendingArchiveRow[];

  let turnsPruned = 0;
  let segmentsPruned = 0;
  for (const row of pending) {
    // THE LATCH. No delete path exists outside this branch.
    if (!custodyProven(row.segment_sha256)) continue;
    journal.exec("BEGIN IMMEDIATE");
    try {
      const info = journal
        .prepare(
          `DELETE FROM turns WHERE conversation_id = ? AND seq BETWEEN ? AND ?`
        )
        .run(row.conversation_id, row.seq_from, row.seq_to);
      journal
        .prepare(`UPDATE conversation_archive SET pruned_at = ? WHERE id = ?`)
        .run(nowMs, row.id);
      journal.exec("COMMIT");
      turnsPruned += Number(info.changes);
      segmentsPruned += 1;
    } catch (error) {
      journal.exec("ROLLBACK");
      throw error;
    }
  }
  return { turnsPruned, segmentsPruned };
}
