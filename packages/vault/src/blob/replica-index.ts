/* oxlint-disable max-classes-per-file -- (#405) ReplicaIndex + AccessIndex are the two durable-table helpers of one cache-index module (blob_replica + blob_access), paired by design */

import type { DatabaseSync } from "node:sqlite";

import { nowIso } from "../ids.js";

export type ReplicaStore = "cas" | "derived";

const IN_CHUNK = 500;

export class ReplicaIndex {
  constructor(private readonly db: DatabaseSync) {}

  mark(sha: string, byteSize: number, store: ReplicaStore = "cas"): void {
    this.db
      .prepare(
        `INSERT INTO blob_replica (sha256, replicated_at, byte_size, store) VALUES (?, ?, ?, ?)
         ON CONFLICT (sha256) DO UPDATE SET replicated_at = excluded.replicated_at,
           byte_size = excluded.byte_size, store = excluded.store`
      )
      .run(sha, nowIso(), byteSize, store);
  }

  storeOf(sha: string): ReplicaStore | undefined {
    const row = this.db
      .prepare("SELECT store FROM blob_replica WHERE sha256 = ?")
      .get(sha) as { store: ReplicaStore } | undefined;
    return row?.store;
  }

  unmark(sha: string): void {
    this.db.prepare("DELETE FROM blob_replica WHERE sha256 = ?").run(sha);
  }

  has(sha: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM blob_replica WHERE sha256 = ?")
        .get(sha) !== undefined
    );
  }

  all(store?: ReplicaStore): Set<string> {
    const rows = (
      store
        ? this.db
            .prepare("SELECT sha256 FROM blob_replica WHERE store = ?")
            .all(store)
        : this.db.prepare("SELECT sha256 FROM blob_replica").all()
    ) as { sha256: string }[];
    return new Set(rows.map((r) => r.sha256));
  }

  rows(): { sha256: string; replicatedAt: string; store: ReplicaStore }[] {
    const rows = this.db
      .prepare("SELECT sha256, replicated_at, store FROM blob_replica")
      .all() as {
      sha256: string;
      replicated_at: string;
      store: ReplicaStore;
    }[];
    return rows.map((row) => ({
      sha256: row.sha256,
      replicatedAt: row.replicated_at,
      store: row.store,
    }));
  }

  clear(): void {
    this.db.exec("DELETE FROM blob_replica");
  }

  heal(
    store: ReplicaStore,
    remoteShas: Set<string>,
    sizeOf: (sha: string) => number
  ): void {
    const known = this.all(store);
    this.db.exec("BEGIN");
    try {
      const del = this.db.prepare(
        "DELETE FROM blob_replica WHERE sha256 = ? AND store = ?"
      );
      for (const sha of known) if (!remoteShas.has(sha)) del.run(sha, store);
      const ins = this.db.prepare(
        `INSERT INTO blob_replica (sha256, replicated_at, byte_size, store) VALUES (?, ?, ?, ?)
         ON CONFLICT (sha256) DO NOTHING`
      );
      const now = nowIso();
      for (const sha of remoteShas)
        if (!known.has(sha)) ins.run(sha, now, sizeOf(sha), store);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class AccessIndex {
  private readonly pending = new Map<
    string,
    { at: string; size: number | null }
  >();

  constructor(private readonly db: DatabaseSync) {}

  touch(sha: string, size?: number): void {
    this.pending.set(sha, { at: nowIso(), size: size ?? null });
  }

  flush(): void {
    if (this.pending.size === 0) return;
    this.db.exec("BEGIN");
    try {
      const up = this.db.prepare(
        `INSERT INTO blob_access (sha256, last_access_at, byte_size) VALUES (?, ?, ?)
         ON CONFLICT (sha256) DO UPDATE SET last_access_at = excluded.last_access_at,
           byte_size = COALESCE(excluded.byte_size, blob_access.byte_size)`
      );
      for (const [sha, v] of this.pending) up.run(sha, v.at, v.size);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.pending.clear();
  }

  drop(sha: string): void {
    this.pending.delete(sha);
    this.db.prepare("DELETE FROM blob_access WHERE sha256 = ?").run(sha);
  }

  orderOldestFirst(candidates: readonly string[]): string[] {
    if (candidates.length === 0) return [];
    const seen = new Map<string, string>(); // sha -> last_access_at
    for (let i = 0; i < candidates.length; i += IN_CHUNK) {
      const chunk = candidates.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT sha256, last_access_at FROM blob_access WHERE sha256 IN (${placeholders})`
        )
        .all(...chunk) as { sha256: string; last_access_at: string }[];
      for (const r of rows) seen.set(r.sha256, r.last_access_at);
    }
    const untouched = candidates.filter((s) => !seen.has(s));
    const touched = candidates
      .filter((s) => seen.has(s))
      .sort((a, b) =>
        seen.get(a)! < seen.get(b)! ? -1 : seen.get(a)! > seen.get(b)! ? 1 : 0
      );
    return [...untouched, ...touched];
  }
}
