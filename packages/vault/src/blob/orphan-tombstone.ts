// `blob_orphan` (#439): GC MUST NOT delete an orphan until N days have
// elapsed since it was FIRST observed orphaned. Stamp on first pass, age
// against that stamp, clear when live/pinned or deleted. The stamp is
// always ≥ true dereference time, so the rule can only over-retain.

import type { DatabaseSync } from "node:sqlite";

export class OrphanTombstoneIndex {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * INSERT OR IGNORE: a second call keeps the original stamp so the grace
   * clock never resets while the sha stays continuously orphaned.
   */
  markFirstSeen(sha: string, nowMs: number): number {
    this.db
      .prepare(
        `INSERT INTO blob_orphan (sha256, first_orphaned_at) VALUES (?, ?)
         ON CONFLICT (sha256) DO NOTHING`
      )
      .run(sha, nowMs);
    // Read back rather than trust `nowMs`: a pre-existing row wins the conflict.
    return this.read(sha)!;
  }

  read(sha: string): number | undefined {
    const row = this.db
      .prepare("SELECT first_orphaned_at FROM blob_orphan WHERE sha256 = ?")
      .get(sha) as { first_orphaned_at: number } | undefined;
    return row?.first_orphaned_at;
  }

  clear(sha: string): void {
    this.db.prepare("DELETE FROM blob_orphan WHERE sha256 = ?").run(sha);
  }

  clearAll(): void {
    this.db.exec("DELETE FROM blob_orphan");
  }
}
