// The orphan-grace tombstone index (issue #439 R4) — the `blob_orphan` table
// (schema/blob.ts) behind a small stateful helper, mirroring ReplicaIndex's
// shape so the reconciliation sweep never writes raw SQL for it. Kept in its
// own leaf module (custody.ts is at the governance line-cap): the machinery
// lives here, custody.ts stays the facade.
//
// This is the record behind the GC orphan-grace invariant: a client that owns
// CAS garbage collection MUST NOT delete an orphaned blob (referenced by
// neither the live vault model nor any retained snapshot manifest) until at
// least N days — the recovery window — have elapsed since the blob was FIRST
// observed orphaned. The sweep stamps that first-observed instant here on the
// pass that first finds a sha orphaned, reads it back on every later pass to
// evaluate the grace, and clears it the moment the sha is live/pinned again (or
// is finally deleted). Because the stamped instant is always ≥ the true
// dereference time, the rule can only ever OVER-retain — never delete a byte a
// recovery-to-N still needs.

import type { DatabaseSync } from 'node:sqlite';

/**
 * The orphan-grace tombstone index (issue #439 R4): durable evidence of WHEN a
 * remote sha was first observed orphaned, in epoch ms. It is a cache of a
 * transient observation, not model — a sha that re-references (or is deleted)
 * loses its row; the sweep re-stamps a fresh one if it goes orphaned again.
 */
export class OrphanTombstoneIndex {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Record — on the FIRST pass only — that `sha` is orphaned as of `nowMs`, and
   * return the stored first-orphaned instant. Idempotent: a second call keeps
   * the ORIGINAL stamp (INSERT OR IGNORE), so the grace clock never resets while
   * the sha stays continuously orphaned. The returned value is what the caller
   * ages against the recovery window.
   */
  markFirstSeen(sha: string, nowMs: number): number {
    this.db
      .prepare(
        `INSERT INTO blob_orphan (sha256, first_orphaned_at) VALUES (?, ?)
         ON CONFLICT (sha256) DO NOTHING`,
      )
      .run(sha, nowMs);
    // Read back rather than trust `nowMs`: a pre-existing row wins the conflict,
    // and its (earlier) stamp is the one the grace must be measured from.
    return this.read(sha)!;
  }

  /** The instant `sha` was first observed orphaned, or undefined when untombstoned. */
  read(sha: string): number | undefined {
    const row = this.db
      .prepare('SELECT first_orphaned_at FROM blob_orphan WHERE sha256 = ?')
      .get(sha) as { first_orphaned_at: number } | undefined;
    return row?.first_orphaned_at;
  }

  /** Forget the tombstone — the sha is live/pinned again, or has been deleted. */
  clear(sha: string): void {
    this.db.prepare('DELETE FROM blob_orphan WHERE sha256 = ?').run(sha);
  }

  /** Drop every tombstone (e.g. when the configured remote identity changes). */
  clearAll(): void {
    this.db.exec('DELETE FROM blob_orphan');
  }
}
