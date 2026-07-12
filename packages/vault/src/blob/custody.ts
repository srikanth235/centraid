// Blob custody facade (issue #296): the two tiers behind one surface.
//
//   local  — a LocalBlobStore, ALWAYS present and always complete: every
//            ingress hashes into it (it is the spool), every egress serves
//            from it, and the synchronous command pipeline touches only it.
//   remote — an optional BlobStore (S3-compatible) that REPLICATES the local
//            tier for durability. Replication is a sweep, never in-line with
//            a write; remote deletes are reconciliation's job (list-diff), so
//            a crash between a local purge and a remote delete costs an
//            orphan object, never a dangling row.
//
// Encryption (settings `blob_store.encrypt`): remote objects seal per blob
// with AES-256-GCM under the vault's DEK (the #293 key custody), AAD
// `blob:<sha>`. Identity and dedup key off the PLAINTEXT sha — re-keying
// never changes an address — and the local tier stays plaintext (it shares
// vault.db's disk trust; the remote tier is the third party).

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { asVaultDiskFullError } from '../errors.js';
import { nowIso } from '../ids.js';
import type { LocalBlobStore } from './local.js';
import { sha256OfBytes, shaOfBlobUri, type BlobRange, type BlobStore } from './store.js';

import { sealBlob, sealBlobStream, unsealBlob } from './seal.js';

export { sealBlob, sealBlobStream, unsealBlob } from './seal.js';

/**
 * Blobs at or above this size stream from disk into the remote tier instead
 * of buffering the whole plaintext (issue #367 §C8) — mirrors
 * `S3BlobStore`'s own `MULTIPART_THRESHOLD_BYTES` so the two decisions line
 * up (a blob under this streams as one small buffered `put` either way).
 */
const STREAMING_REPLICATE_THRESHOLD_BYTES = 32 * 1024 * 1024;


/** How the host resolves the (settings-declared) remote tier on demand. */
export interface RemoteTier {
  store: BlobStore;
  /** Seal remote objects with this key (settings `blob_store.encrypt`). */
  encryptKey?: Buffer;
}

/**
 * Per-content custody state (issue #352 phase 3/4): whether a piece of
 * content's ORIGINAL bytes sit in the local tier, the remote tier, both, or
 * (an integrity gap) neither. `blob_custody_state` mirrors this per
 * content_id — see `refreshCustodyState` below and schema/blob.ts.
 */
export type CustodyState = 'local-only' | 'replicated' | 'remote-only' | 'missing';

export interface ReconcileResult {
  /** Remote objects no live sha claims — deleted. */
  orphansDeleted: string[];
  /** Live shas the remote tier is missing — replicated now. */
  replicated: string[];
  /** Live shas missing from BOTH tiers — an integrity error, reported. */
  missing: string[];
  /**
   * Remote objects that WOULD have been deleted as orphans, had the caller
   * not passed `skipOrphanDelete` (issue #367 §C6 — the gateway instance
   * lease is conflicted, so a second live gateway process might legitimately
   * still be writing here). Empty whenever orphan-delete ran normally.
   */
  orphansSkipped: string[];
}

export interface ReconcileOptions {
  /**
   * Skip the orphan-DELETE phase (issue #367 §C6): while the gateway
   * instance lease is conflicted (two processes may be live against the
   * same vault), an object this process doesn't recognize might be one the
   * OTHER instance just wrote — deleting it would be a real data-loss risk,
   * not a cosmetic one. Replication (push) and missing-detection still run;
   * only the destructive delete phase pauses.
   */
  skipOrphanDelete?: boolean;
}

/**
 * The standing sweep's own liveness (issue #351 wave 4, #367 prep): before
 * this, a `reconcile()` failure only ever surfaced as a one-line log warn
 * from `VaultPlane.runSweep` — nothing a health probe could read back. Kept
 * in-memory only (process-lifetime, per `BlobCustody` instance = per mounted
 * vault): a rebuildable liveness signal, not a durable fact worth its own
 * table.
 */
export interface BlobSweepStatus {
  /** ISO timestamp of the last `reconcile()` that returned without throwing. */
  lastCompletedAt: string | null;
  /**
   * ISO timestamp of the last `reconcile()` ATTEMPT, success or failure
   * (issue #367 §C5) — `lastCompletedAt` only moves on success, so a caller
   * computing a failure backoff window needs this to know when the clock
   * for "try again" actually started.
   */
  lastAttemptedAt: string | null;
  /** The last `reconcile()` failure's message, cleared on the next success. */
  lastError: string | null;
  /** Consecutive failures since the last success — the `blob-sweep` probe's "persistent vs. transient" line. */
  consecutiveFailures: number;
}

/**
 * The standing sweep's own liveness (issue #351 wave 4, #367 prep): before
 * this, a `reconcile()` failure only ever surfaced as a one-line log warn
 * from `VaultPlane.runSweep` — nothing a health probe could read back. Kept
 * in-memory only (process-lifetime, per `BlobCustody` instance = per mounted
 * vault): a rebuildable liveness signal, not a durable fact worth its own
 * table.
 */
export interface BlobSweepStatus {
  /** ISO timestamp of the last `reconcile()` that returned without throwing. */
  lastCompletedAt: string | null;
  /** The last `reconcile()` failure's message, cleared on the next success. */
  lastError: string | null;
  /** Consecutive failures since the last success — the `blob-sweep` probe's "persistent vs. transient" line. */
  consecutiveFailures: number;
}

export class BlobCustody {
  private lastSweepCompletedAt: string | null = null;
  private lastSweepAttemptedAt: string | null = null;
  private lastSweepError: string | null = null;
  private sweepConsecutiveFailures = 0;

  constructor(
    readonly local: LocalBlobStore,
    /**
     * Resolved lazily on every use: the remote tier follows the CURRENT
     * settings row, so switching `blob_store` needs no reopen. Returns null
     * when the vault is local-only.
     */
    private readonly remoteTier: () => RemoteTier | null,
  ) {}

  /** The `blob-sweep` health probe's read of the last `reconcile()` run. */
  sweepStatus(): BlobSweepStatus {
    return {
      lastCompletedAt: this.lastSweepCompletedAt,
      lastAttemptedAt: this.lastSweepAttemptedAt,
      lastError: this.lastSweepError,
      consecutiveFailures: this.sweepConsecutiveFailures,
    };
  }

  /** Hash raw bytes and store them locally — the one ingress everything uses. */
  ingestSync(bytes: Buffer): { sha256: string; byteSize: number } {
    const sha = sha256OfBytes(bytes);
    this.local.putSync(sha, bytes);
    return { sha256: sha, byteSize: bytes.length };
  }

  hasSync(sha: string): boolean {
    return this.local.hasSync(sha);
  }

  getSync(sha: string, range?: BlobRange): Buffer | null {
    return this.local.getSync(sha, range);
  }

  statSync(sha: string): { size: number } | null {
    return this.local.statSync(sha);
  }

  /** Local hit, else remote fetch (unsealing if configured) + re-cache. */
  async open(sha: string, range?: BlobRange): Promise<Buffer | null> {
    const localHit = this.local.getSync(sha, range);
    if (localHit) return localHit;
    const remote = this.remoteTier();
    if (!remote) return null;
    // Sealed objects can't honor a byte range remotely — fetch whole, unseal,
    // cache locally, then slice. Plain remotes could range-read, but caching
    // the whole blob is what makes the next read local; blobs are bounded.
    const raw = await remote.store.get(sha);
    if (!raw) return null;
    const plain = remote.encryptKey ? unsealBlob(remote.encryptKey, sha, raw) : raw;
    if (sha256OfBytes(plain) !== sha) {
      throw new Error(`remote blob ${sha} failed content verification`);
    }
    this.local.putSync(sha, plain);
    return this.local.getSync(sha, range);
  }

  /** Delete the local copy now; the remote copy falls to reconciliation. */
  deleteLocalSync(sha: string): void {
    this.local.deleteSync(sha);
  }

  /** Best-effort immediate delete on both tiers (vault deletion path). */
  async deleteEverywhere(sha: string): Promise<void> {
    this.local.deleteSync(sha);
    const remote = this.remoteTier();
    if (remote) await remote.store.delete(sha);
  }

  /** Push every local sha the remote tier lacks. Returns what moved. */
  async replicate(shas?: string[]): Promise<string[]> {
    const remote = this.remoteTier();
    if (!remote) return [];
    const want = shas ?? this.local.listSync();
    const there = new Set(await remote.store.list());
    const moved: string[] = [];
    for (const sha of want) {
      if (there.has(sha)) continue;
      if (await this.replicateOne(remote, sha)) moved.push(sha);
    }
    return moved;
  }

  /**
   * Push one sha to the remote tier, streaming from disk when it's large
   * enough to matter (issue #367 §C8) and both tiers support it; otherwise
   * the original buffered path. `false` when the local tier no longer has
   * this sha (raced with a delete — not an error, just nothing to push).
   */
  private async replicateOne(remote: RemoteTier, sha: string): Promise<boolean> {
    const openStream = this.local.openReadStreamSync?.bind(this.local);
    if (openStream && remote.store.putStream) {
      const opened = openStream(sha);
      if (opened) {
        if (opened.size < STREAMING_REPLICATE_THRESHOLD_BYTES) {
          // Small enough that streaming buys nothing — fall through to the
          // buffered path below, which also exercises `getSync`'s normal
          // caching-adjacent semantics for small blobs.
        } else {
          const source = remote.encryptKey
            ? opened.stream.pipe(sealBlobStream(remote.encryptKey, sha))
            : opened.stream;
          await remote.store.putStream(sha, source, opened.size);
          return true;
        }
      } else {
        return false; // local tier raced a delete out from under us
      }
    }
    const bytes = this.local.getSync(sha);
    if (!bytes) return false;
    await remote.store.put(sha, remote.encryptKey ? sealBlob(remote.encryptKey, sha, bytes) : bytes);
    return true;
  }

  /**
   * The reconciliation sweep (issue #296 §6): remote list vs the live sha
   * set. Orphans (remote objects nothing claims) delete; missing replicas
   * re-push; shas absent from BOTH tiers are reported, never invented.
   *
   * Records `sweepStatus()` around the same try/catch a caller would need
   * anyway — success or failure, every run stamps a result the `blob-sweep`
   * health probe can read without polling logs. The original throw still
   * propagates (`VaultPlane.runSweep` already catches it to log a warning);
   * this only ADDS a readable trace of that same outcome.
   */
  async reconcile(liveShas: Set<string>, options: ReconcileOptions = {}): Promise<ReconcileResult> {
    this.lastSweepAttemptedAt = nowIso();
    try {
      const result = await this.doReconcile(liveShas, options);
      this.lastSweepCompletedAt = nowIso();
      this.lastSweepError = null;
      this.sweepConsecutiveFailures = 0;
      return result;
    } catch (err) {
      this.lastSweepError = err instanceof Error ? err.message : String(err);
      this.sweepConsecutiveFailures += 1;
      throw err;
    }
  }

  private async doReconcile(
    liveShas: Set<string>,
    options: ReconcileOptions,
  ): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      orphansDeleted: [],
      replicated: [],
      missing: [],
      orphansSkipped: [],
    };
    const remote = this.remoteTier();
    const remoteShas = remote ? new Set(await remote.store.list()) : new Set<string>();
    if (remote) {
      for (const sha of remoteShas) {
        if (liveShas.has(sha)) continue;
        if (options.skipOrphanDelete) {
          result.orphansSkipped.push(sha);
          continue;
        }
        await remote.store.delete(sha);
        result.orphansDeleted.push(sha);
      }
    }
    for (const sha of liveShas) {
      const localHas = this.local.hasSync(sha);
      if (!localHas && remote && remoteShas.has(sha)) {
        await this.open(sha); // re-cache from remote
        result.replicated.push(sha);
        continue;
      }
      if (localHas && remote && !remoteShas.has(sha)) {
        result.replicated.push(...(await this.replicate([sha])));
        continue;
      }
      if (!localHas && (!remote || !remoteShas.has(sha))) result.missing.push(sha);
    }
    return result;
  }

  /**
   * Purge EVERY remote object (vault deletion, issue #296 §6). The remote
   * tier resolves synchronously HERE — before the first await — so callers
   * may close the vault handles right after invoking and let the deletes
   * run detached.
   */
  purgeRemote(): Promise<string[]> {
    const remote = this.remoteTier();
    if (!remote) return Promise.resolve([]);
    return (async () => {
      const shas = await remote.store.list();
      for (const sha of shas) await remote.store.delete(sha);
      return shas;
    })();
  }

  /**
   * Non-mutating custody status per sha (issue #352 phase 3/4) — the
   * read-path snapshot `refreshCustodyState` persists into
   * `blob_custody_state`. Unlike `reconcile`, this never pushes, deletes or
   * re-caches; it only asks each tier what it currently holds, so it is safe
   * to call from anywhere (including mid-sweep, right after `reconcile` has
   * already brought the tiers into their steady state).
   */
  async statusFor(shas: Iterable<string>): Promise<Map<string, CustodyState>> {
    const remote = this.remoteTier();
    const remoteShas = remote ? new Set(await remote.store.list()) : null;
    const out = new Map<string, CustodyState>();
    for (const sha of shas) {
      const local = this.local.hasSync(sha);
      const remoteHas = remoteShas?.has(sha) ?? false;
      if (remoteShas === null) {
        out.set(sha, local ? 'local-only' : 'missing');
      } else if (local && remoteHas) {
        out.set(sha, 'replicated');
      } else if (local) {
        out.set(sha, 'local-only');
      } else if (remoteHas) {
        out.set(sha, 'remote-only');
      } else {
        out.set(sha, 'missing');
      }
    }
    return out;
  }

  /**
   * Copy the whole local tier into `destDir/blobs` — the self-contained
   * export/backup gesture (issue #296 §6: the exit ramp from S3 is a
   * directory). The local tier is always complete, so no remote pull needed.
   */
  exportTo(destDir: string): { copied: number } {
    const shas = this.local.listSync();
    const destRoot = path.join(destDir, 'blobs');
    let copied = 0;
    for (const sha of shas) {
      const bytes = this.local.getSync(sha);
      if (!bytes) continue;
      const file = path.join(destRoot, 'sha256', sha.slice(0, 2), sha);
      if (!existsSync(file)) {
        writeBlobFile(file, bytes);
        copied += 1;
      }
    }
    return { copied };
  }
}

/** Write-then-rename so a crashed export never leaves a half blob. */
function writeBlobFile(file: string, bytes: Buffer): void {
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    // Same rule as the CAS write path (blob/local.ts): a disk-full export
    // never leaves a partial `.tmp` file next to the real blob path.
    rmSync(tmp, { force: true });
    throw asVaultDiskFullError('blob export write', err);
  }
}

/**
 * Persist a custody-state snapshot into `blob_custody_state` (issue #352
 * phase 3/4) — the rebuildable projection apps read as `blob.custody_state`
 * (schema/tables.ts). Only LIVE content items' ORIGINAL bytes are covered —
 * derivatives (thumb/preview) are an implementation detail of serving, not
 * something an app needs custody visibility into. Called from the standing
 * blob sweep (gateway.ts `sweepBlobs`), right after `reconcile()` has already
 * brought both tiers to their steady state, so the snapshot reflects the
 * POST-sweep truth. A full delete+reinsert every run — cheap at personal-vault
 * scale, and it means a purged/trashed content item's stale row can never
 * linger (rebuildable projection, never a durable fact of its own).
 */
export async function refreshCustodyState(db: VaultDb): Promise<{ updated: number }> {
  const rows = db.vault
    .prepare(
      `SELECT content_id, content_uri FROM core_content_item
        WHERE content_uri LIKE 'blob:%' AND deleted_at IS NULL`,
    )
    .all() as { content_id: string; content_uri: string }[];
  const byContent = new Map<string, string>();
  const shas = new Set<string>();
  for (const row of rows) {
    const sha = shaOfBlobUri(row.content_uri);
    if (!sha) continue;
    byContent.set(row.content_id, sha);
    shas.add(sha);
  }
  const status = await db.blobs.statusFor(shas);
  const now = nowIso();
  db.vault.exec('BEGIN');
  try {
    db.vault.prepare('DELETE FROM blob_custody_state').run();
    const insert = db.vault.prepare(
      `INSERT INTO blob_custody_state (content_id, sha256, custody_state, checked_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [contentId, sha] of byContent) {
      insert.run(contentId, sha, status.get(sha) ?? 'missing', now);
    }
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  return { updated: byContent.size };
}

/**
 * Cheap per-vault custody breakdown (issue #351 wave 4, #367 prep): counts
 * `blob_custody_state` GROUP BY state — read-only, no tier I/O — so the
 * `blob-sweep` health probe (and #367's later Storage UI card) get
 * replicated-vs-backlog counts without re-listing the remote tier on every
 * poll. Zero-filled for states the mirror currently has no rows in, so
 * callers never need an `?? 0` per key.
 */
export function custodyStateCounts(vault: DatabaseSync): Record<CustodyState, number> {
  const counts: Record<CustodyState, number> = {
    'local-only': 0,
    replicated: 0,
    'remote-only': 0,
    missing: 0,
  };
  const rows = vault
    .prepare(`SELECT custody_state, COUNT(*) AS n FROM blob_custody_state GROUP BY custody_state`)
    .all() as { custody_state: CustodyState; n: number }[];
  for (const row of rows) counts[row.custody_state] = row.n;
  return counts;
}

/**
 * Byte-summed twin of `custodyStateCounts` (issue #367 §C7): the Storage
 * status route wants replicated/backlog progress in BYTES, not just object
 * counts — `core_content_item.byte_size` is already the authoritative size
 * per content id (schema/core.ts), so this is one more GROUP BY join, not a
 * second tier scan. Kept as a separate function rather than widening
 * `custodyStateCounts`'s return shape — the `blob-sweep` health probe (and
 * any other existing caller) only ever wanted counts.
 */
export function custodyStateByteCounts(vault: DatabaseSync): Record<CustodyState, number> {
  const bytes: Record<CustodyState, number> = {
    'local-only': 0,
    replicated: 0,
    'remote-only': 0,
    missing: 0,
  };
  const rows = vault
    .prepare(
      `SELECT s.custody_state AS custody_state, COALESCE(SUM(c.byte_size), 0) AS bytes
         FROM blob_custody_state s
         JOIN core_content_item c ON c.content_id = s.content_id
        GROUP BY s.custody_state`,
    )
    .all() as { custody_state: CustodyState; bytes: number }[];
  for (const row of rows) bytes[row.custody_state] = row.bytes;
  return bytes;
}
