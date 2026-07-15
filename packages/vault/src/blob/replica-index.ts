// The durable replication index and LRU access tracker (issue #405 §3/§4) —
// the two `blob_replica` / `blob_access` tables (schema/blob.ts) behind small
// stateful helpers so the custody facade and the cache coordinator never write
// raw SQL for either. Kept in their own leaf module (custody.ts is at the
// governance line-cap): the machinery lives here, custody.ts stays the facade.

/* eslint-disable max-classes-per-file -- (#405) ReplicaIndex + AccessIndex are the two durable-table helpers of one cache-index module (blob_replica + blob_access), paired by design */

import type { DatabaseSync } from 'node:sqlite';
import { nowIso } from '../ids.js';

/**
 * Chunked IN-list size for the LRU ordering query — SQLite's default variable
 * ceiling is far above this, but a bounded list keeps the prepared statement
 * small and the plan stable across arbitrarily large candidate sets.
 */
const IN_CHUNK = 500;

/**
 * The replication index (issue #405 §4): durable local EVIDENCE that a sha has
 * been pushed to the remote tier and acknowledged (a 2xx). `statusFor()` and
 * `replicate()` read this instead of a live `remote.list()`; evict-only-if-
 * replicated (§3) consults it before deleting any local copy. It is a cache of
 * evidence — `reconcile()`'s full remote listing is truth and `heal()` rebuilds
 * this table from it.
 */
export class ReplicaIndex {
  constructor(private readonly db: DatabaseSync) {}

  /** Record (or refresh) evidence that `sha` is replicated. Idempotent. */
  mark(sha: string, byteSize: number): void {
    this.db
      .prepare(
        `INSERT INTO blob_replica (sha256, replicated_at, byte_size) VALUES (?, ?, ?)
         ON CONFLICT (sha256) DO UPDATE SET replicated_at = excluded.replicated_at,
           byte_size = excluded.byte_size`,
      )
      .run(sha, nowIso(), byteSize);
  }

  /** Drop the evidence — the remote copy is gone (delete/purge/orphan-sweep). */
  unmark(sha: string): void {
    this.db.prepare('DELETE FROM blob_replica WHERE sha256 = ?').run(sha);
  }

  /** Whether we hold durable evidence `sha` is on the remote tier. */
  has(sha: string): boolean {
    return this.db.prepare('SELECT 1 FROM blob_replica WHERE sha256 = ?').get(sha) !== undefined;
  }

  /** The full set of shas the index believes are replicated. */
  all(): Set<string> {
    const rows = this.db.prepare('SELECT sha256 FROM blob_replica').all() as { sha256: string }[];
    return new Set(rows.map((r) => r.sha256));
  }

  /**
   * Reconcile the index against a full remote listing (issue #404 §4 rebuild
   * path): the remote's real object set is TRUTH, so rows for shas the remote
   * no longer has are dropped and shas the remote has but the index missed are
   * added. Sizes for freshly-added rows come from `sizeOf` (the local tier's
   * stat) when known, else 0 — the index's job is presence, not accounting.
   */
  heal(remoteShas: Set<string>, sizeOf: (sha: string) => number): void {
    const known = this.all();
    this.db.exec('BEGIN');
    try {
      const del = this.db.prepare('DELETE FROM blob_replica WHERE sha256 = ?');
      for (const sha of known) if (!remoteShas.has(sha)) del.run(sha);
      const ins = this.db.prepare(
        `INSERT INTO blob_replica (sha256, replicated_at, byte_size) VALUES (?, ?, ?)
         ON CONFLICT (sha256) DO NOTHING`,
      );
      const now = nowIso();
      for (const sha of remoteShas) if (!known.has(sha)) ins.run(sha, now, sizeOf(sha));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * The LRU access tracker (issue #405 §3): last-access time per sha with an
 * in-memory WRITE-BEHIND buffer, so the hot sync read path never pays a
 * synchronous SQLite write per read. Touches land in `pending`; `flush()`
 * upserts them in one transaction (called at sweep boundaries and before an
 * eviction pass reads ordering). A sha with no row sorts OLDEST.
 */
export class AccessIndex {
  private readonly pending = new Map<string, { at: string; size: number | null }>();

  constructor(private readonly db: DatabaseSync) {}

  /** Record an access — in memory only (write-behind); flushed later. */
  touch(sha: string, size?: number): void {
    this.pending.set(sha, { at: nowIso(), size: size ?? null });
  }

  /** Persist the buffered touches in one transaction, then clear the buffer. */
  flush(): void {
    if (this.pending.size === 0) return;
    this.db.exec('BEGIN');
    try {
      const up = this.db.prepare(
        `INSERT INTO blob_access (sha256, last_access_at, byte_size) VALUES (?, ?, ?)
         ON CONFLICT (sha256) DO UPDATE SET last_access_at = excluded.last_access_at,
           byte_size = COALESCE(excluded.byte_size, blob_access.byte_size)`,
      );
      for (const [sha, v] of this.pending) up.run(sha, v.at, v.size);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.pending.clear();
  }

  /** Forget a sha entirely (it left the local tier) — buffer and table both. */
  drop(sha: string): void {
    this.pending.delete(sha);
    this.db.prepare('DELETE FROM blob_access WHERE sha256 = ?').run(sha);
  }

  /**
   * Order `candidates` oldest-access first for the eviction pass. Shas with no
   * access row are OLDEST (never touched since landing), returned first in
   * their given order; the rest follow by ascending `last_access_at`. Callers
   * should `flush()` first so in-flight touches are reflected.
   */
  orderOldestFirst(candidates: readonly string[]): string[] {
    if (candidates.length === 0) return [];
    const seen = new Map<string, string>(); // sha -> last_access_at
    for (let i = 0; i < candidates.length; i += IN_CHUNK) {
      const chunk = candidates.slice(i, i + IN_CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const rows = this.db
        .prepare(`SELECT sha256, last_access_at FROM blob_access WHERE sha256 IN (${placeholders})`)
        .all(...chunk) as { sha256: string; last_access_at: string }[];
      for (const r of rows) seen.set(r.sha256, r.last_access_at);
    }
    const untouched = candidates.filter((s) => !seen.has(s));
    const touched = candidates
      .filter((s) => seen.has(s))
      .sort((a, b) => (seen.get(a)! < seen.get(b)! ? -1 : seen.get(a)! > seen.get(b)! ? 1 : 0));
    return [...untouched, ...touched];
  }
}
