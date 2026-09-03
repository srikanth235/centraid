import type { DatabaseSync } from "node:sqlite";

export class OrphanTombstoneIndex {
  constructor(private readonly db: DatabaseSync) {}

  markFirstSeen(sha: string, nowMs: number): number {
    this.db
      .prepare(
        `INSERT INTO blob_orphan (sha256, first_orphaned_at) VALUES (?, ?)
         ON CONFLICT (sha256) DO NOTHING`
      )
      .run(sha, nowMs);
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
