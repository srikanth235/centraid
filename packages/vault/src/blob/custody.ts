// Blob custody facade (issue #296, cache model reworked in #405 §3/§4): the
// two tiers behind one surface.
//
//   local  — a LocalBlobStore that is the spool AND a BOUNDED cache (issue #405
//            §3 — it was "ALWAYS present and always complete" before the bounded
//            storage tier). It no longer mirrors the whole vault: tinies are
//            pinned unevictable, replicated mediums/originals evict LRU under
//            budget, and a `remote-only` blob reads through on demand (`open`)
//            and re-promotes. The eviction path may NEVER delete the last local
//            copy of a `local-only` (un-replicated) blob — cache pressure
//            BACKPRESSURES ingest, it never loses bytes (evict-only-if-
//            replicated, enforced in the custody layer / cache.ts primitive).
//   remote — an optional BlobStore (S3-compatible) that REPLICATES the local
//            tier for durability. Replication is a sweep, never in-line with
//            a write; remote deletes are reconciliation's job (list-diff), so
//            a crash between a local purge and a remote delete costs an
//            orphan object, never a dangling row.
//
// The bounded cache is coordinated by an optional `BlobCache` (blob/cache.ts):
// budget, spool accounting, the replication index, LRU tracking, eviction,
// metrics and the QoS gate. With one wired (db.ts), custody consults the
// replication INDEX instead of a live `remote.list()` for `statusFor`/
// `replicate` (§4 — no O(all-objects) listing per sweep) and runs the ingest
// precheck; without one (legacy unit tests), it lists the remote as before.
//
// Encryption (settings `blob_store.encrypt`): remote objects seal per blob with
// AES-256-GCM under the vault's DEK (#293 key custody), AAD `blob:<sha>`.
// Identity/dedup key off the PLAINTEXT sha; the local tier stays plaintext (it
// shares vault.db's disk trust; the remote tier is the third party).

import { nowIso } from '../ids.js';
import type { LocalBlobStore } from './local.js';
import { resolveRange, sha256OfBytes, type BlobRange } from './store.js';

import { sealBlob, sealBlobStream, unsealBlob } from './seal.js';
import { exportLocalTier } from './custody-export.js';
import { fetchFrameDirectory, fetchRemoteRange, fetchRemoteWhole } from './custody-read.js';
import type { FrameDirectory } from './seal-frames.js';
// The tier + reconcile + sweep-status value types (and CustodyState) live in
// custody-types.ts so this facade stays under the governance line-cap (issue
// #405 §3 note); re-exported below so every `./custody.js` importer is
// untouched by the split.
import type {
  CustodyState,
  RemoteTier,
  ReconcileResult,
  ReconcileOptions,
  BlobSweepStatus,
} from './custody-types.js';
import {
  DEFAULT_REPLICATION_CONCURRENCY,
  EMPTY_BLOB_METRICS,
  type BlobCache,
  type BlobMetrics,
} from './cache.js';
import { driveReplication } from './replicate-driver.js';

export { sealBlob, sealBlobStream, unsealBlob } from './seal.js';
export type {
  CustodyState,
  RemoteTier,
  ReconcileResult,
  ReconcileOptions,
  BlobSweepStatus,
} from './custody-types.js';
// Custody-state projection helpers live in a sibling module (issue #352);
// re-exported here so `./custody.js` importers (index.ts, gateway.ts) are
// untouched by the split.
export {
  refreshCustodyState,
  custodyStateCounts,
  custodyStateByteCounts,
} from './custody-state.js';

/**
 * Blobs at or above this size stream from disk into the remote tier instead
 * of buffering the whole plaintext (issue #367 §C8) — mirrors
 * `S3BlobStore`'s own `MULTIPART_THRESHOLD_BYTES` so the two decisions line
 * up (a blob under this streams as one small buffered `put` either way).
 */
const STREAMING_REPLICATE_THRESHOLD_BYTES = 32 * 1024 * 1024;

export class BlobCustody {
  private lastSweepCompletedAt: string | null = null;
  private lastSweepAttemptedAt: string | null = null;
  private lastSweepError: string | null = null;
  private sweepConsecutiveFailures = 0;

  /**
   * Single-flight coalescing (issue #405 §4): two concurrent `open()` calls
   * for the same cold sha must produce ONE provider GET, not two full
   * downloads + two unseals. The whole-read map shares the full read-through
   * (fetch + unseal + verify + promote); the directory map shares the footer
   * fetch across concurrent RANGED readers of the same sha. Both clear on
   * settle so a later read re-fetches (never a stale cache).
   */
  private readonly wholeInflight = new Map<string, Promise<Buffer | null>>();
  private readonly dirInflight = new Map<string, Promise<FrameDirectory | null>>();

  constructor(
    readonly local: LocalBlobStore,
    /**
     * Resolved lazily on every use: the remote tier follows the CURRENT
     * settings row, so switching `blob_store` needs no reopen. Returns null
     * when the vault is local-only.
     */
    private readonly remoteTier: () => RemoteTier | null,
    /**
     * The bounded-cache coordinator (issue #405 §3/§4). Present ⇒ the ingest
     * precheck, replication index, LRU tracking, eviction, metrics and the QoS
     * gate are all live. Absent (legacy unit tests) ⇒ pre-#405 behavior: no
     * eviction, and `statusFor`/`replicate` list the remote directly.
     */
    private readonly cache?: BlobCache,
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

  /**
   * Hash raw bytes and store them locally — the one ingress everything uses.
   * With a cache wired (issue #405 §3/§5), a NEW blob first passes the budget
   * precheck (`cache.admit`): evict to make room, or `VaultBlobBackpressureError`
   * when nothing is safely evictable — never deleting un-replicated bytes to fit.
   * The precheck COMPOSES with the hard `VaultDiskFullError` (blob/local.ts): the
   * soft budget vs. the real ENOSPC floor.
   */
  ingestSync(bytes: Buffer): { sha256: string; byteSize: number } {
    const sha = sha256OfBytes(bytes);
    const existed = this.local.hasSync(sha);
    // A NEW blob passes the budget precheck (may evict; may throw
    // VaultBlobBackpressureError). A dedup hit adds no spool → skips both.
    if (this.cache && !existed) this.cache.admit(bytes.length);
    this.local.putSync(sha, bytes);
    if (this.cache && !existed) this.cache.onPut(bytes.length);
    return { sha256: sha, byteSize: bytes.length };
  }

  hasSync(sha: string): boolean {
    return this.local.hasSync(sha);
  }

  getSync(sha: string, range?: BlobRange): Buffer | null {
    const hit = this.local.getSync(sha, range);
    if (hit && this.cache) {
      this.cache.onLocalHit(hit.length);
      this.cache.access.touch(sha);
    }
    return hit;
  }

  statSync(sha: string): { size: number } | null {
    return this.local.statSync(sha);
  }

  /**
   * Local hit, else remote read-through (issue #405 §1/§4). Two shapes:
   *  - RANGE on a SEALED remote: fetch the footer directory + ONLY the covering
   *    frames, unseal those, serve the slice — never the whole object, and NOT
   *    promoting (a partial read can't verify the whole-blob sha; per-frame
   *    GCM+AAD is the integrity story). The directory fetch coalesces.
   *  - Everything else: single-flight coalesced FULL read-through — one provider
   *    GET, unseal whole, verify the sha, promote into local, then slice.
   */
  async open(sha: string, range?: BlobRange): Promise<Buffer | null> {
    const localHit = this.local.getSync(sha, range);
    if (localHit) {
      if (this.cache) {
        this.cache.onLocalHit(localHit.length);
        this.cache.access.touch(sha);
      }
      return localHit;
    }
    const remote = this.remoteTier();
    if (!remote) return null;
    // Serving a byte a caller is waiting on is an INTERACTIVE read (issue #405
    // §7) — bulk replication yields to it (marked in flight until settle).
    this.cache?.enterInteractive();
    try {
      if (range && remote.encryptKey) {
        const dir = await this.readDirectory(remote, sha);
        if (!dir) return null;
        const sliced = await fetchRemoteRange(remote.store, remote.encryptKey, sha, range, dir);
        if (sliced) this.cache?.onRangedRemote(sliced.length);
        return sliced;
      }

      const plain = await this.readWhole(remote, sha);
      if (plain === null) return null;
      if (!range) return plain;
      const resolved = resolveRange(plain.length, range);
      return resolved ? plain.subarray(resolved.start, resolved.end + 1) : null;
    } finally {
      this.cache?.exitInteractive();
    }
  }

  /**
   * The single-flight full read-through (issue #405 §4): fetch the whole
   * remote object, unseal it whole, verify the whole-blob sha, and promote it
   * into the local tier — sharing ONE in-flight promise across concurrent
   * callers so a cold sha triggers exactly one provider GET.
   */
  private readWhole(remote: RemoteTier, sha: string): Promise<Buffer | null> {
    const existing = this.wholeInflight.get(sha);
    if (existing) return existing;
    const started = (async () => {
      const plain = await fetchRemoteWhole(remote.store, remote.encryptKey, sha, unsealBlob);
      if (plain === null) return null;
      if (sha256OfBytes(plain) !== sha) {
        throw new Error(`remote blob ${sha} failed content verification`);
      }
      // Read-through promotes the cold blob into the local tier (issue #405
      // §3): count the remote fetch, account new spool bytes, touch LRU. A
      // promote is NOT a fresh ingest — it bypasses the budget precheck (the
      // bytes already exist remotely; re-caching them can't lose anything).
      const existed = this.local.hasSync(sha);
      this.local.putSync(sha, plain);
      if (this.cache) {
        this.cache.onReadThrough(plain.length);
        if (!existed) this.cache.onPut(plain.length);
        this.cache.access.touch(sha, plain.length);
      }
      return plain;
    })();
    this.wholeInflight.set(sha, started);
    // The initiating caller owns the cleanup; coalesced callers just await the
    // same already-resolving promise, so the map entry outlives none of them.
    return started.finally(() => this.wholeInflight.delete(sha));
  }

  /** Coalesced footer-directory fetch for ranged sealed reads (issue #405 §4). */
  private readDirectory(remote: RemoteTier, sha: string): Promise<FrameDirectory | null> {
    const existing = this.dirInflight.get(sha);
    if (existing) return existing;
    const key = remote.encryptKey!;
    const started = fetchFrameDirectory(remote.store, key, sha);
    this.dirInflight.set(sha, started);
    return started.finally(() => this.dirInflight.delete(sha));
  }

  /**
   * Delete the local copy now; the remote copy (if any) holds. Adjusts spool
   * accounting and drops the LRU row, but does NOT unmark the replication index
   * — a replicated sha deleted locally is now legitimately `remote-only`.
   */
  deleteLocalSync(sha: string): void {
    const size = this.cache ? (this.local.statSync(sha)?.size ?? 0) : 0;
    this.local.deleteSync(sha);
    if (this.cache) {
      this.cache.onDelete(size);
      this.cache.access.drop(sha);
    }
  }

  /** Best-effort immediate delete on both tiers (vault deletion path). */
  async deleteEverywhere(sha: string): Promise<void> {
    const size = this.cache ? (this.local.statSync(sha)?.size ?? 0) : 0;
    this.local.deleteSync(sha);
    if (this.cache) {
      this.cache.onDelete(size);
      this.cache.access.drop(sha);
      this.cache.replica.unmark(sha);
    }
    const remote = this.remoteTier();
    if (remote) await remote.store.delete(sha);
  }

  /**
   * Run the eviction pass on demand (issue #405 §3) — the sweep-side hook.
   * Sheds replicated LRU mediums/originals until the spool is under budget,
   * never a pinned tiny/staged/un-replicated blob. Zeros when no cache is wired.
   */
  evict(): { evictedBlobs: number; evictedBytes: number } {
    if (!this.cache) return { evictedBlobs: 0, evictedBytes: 0 };
    const { evicted, bytes } = this.cache.runEviction();
    return { evictedBlobs: evicted.length, evictedBytes: bytes };
  }

  /** Process-lifetime custody + cache counters (issue #405 §7). */
  metrics(): BlobMetrics {
    return this.cache?.metrics() ?? EMPTY_BLOB_METRICS;
  }

  /**
   * Push every local sha the remote tier lacks (issue #405 §4). With a cache
   * wired, "already there" comes from the replication INDEX — durable local
   * evidence — so this performs ZERO remote `list()` calls (the deep
   * `reconcile()` still lists once; steady-state replication must not). Pushes
   * are BOUNDED-PARALLEL (default 3) and yield to interactive reads (QoS)
   * between blobs; each success records index evidence (via `pushOne`).
   */
  async replicate(shas?: string[]): Promise<string[]> {
    const remote = this.remoteTier();
    if (!remote) return [];
    const want = shas ?? this.local.listSync();
    const alreadyThere = this.cache ? this.cache.replica.all() : new Set(await remote.store.list());
    return driveReplication({
      want,
      alreadyThere,
      pushOne: (sha) => this.pushOne(remote, sha),
      concurrency: this.cache?.replicationConcurrency ?? DEFAULT_REPLICATION_CONCURRENCY,
      // QoS (issue #405 §7): with a cache, park behind interactive reads.
      qosWait: this.cache ? () => this.cache!.qosWait() : () => Promise.resolve(),
    });
  }

  /** Push one sha and, on success, record durable replication evidence (issue #405 §4). */
  private async pushOne(remote: RemoteTier, sha: string): Promise<boolean> {
    const moved = await this.replicateOne(remote, sha);
    if (moved && this.cache) this.cache.replica.mark(sha, this.local.statSync(sha)?.size ?? 0);
    return moved;
  }

  /**
   * Push one sha to the remote tier, streaming from disk when it's large
   * enough to matter (issue #367 §C8) and both tiers support it; otherwise
   * the original buffered path. `false` when the local tier no longer has
   * this sha (raced with a delete — not an error, just nothing to push).
   */
  private async replicateOne(remote: RemoteTier, sha: string): Promise<boolean> {
    const threshold = remote.streamThresholdBytes ?? STREAMING_REPLICATE_THRESHOLD_BYTES;
    const openStream = this.local.openReadStreamSync?.bind(this.local);
    if (openStream && remote.store.putStream) {
      const opened = openStream(sha);
      if (opened) {
        if (opened.size < threshold) {
          // Small enough that streaming buys nothing — fall through to the
          // buffered path below, which also exercises `getSync`'s normal
          // caching-adjacent semantics for small blobs.
        } else {
          // Framed streaming seal (issue #405 §1): the total plaintext size is
          // known here (from `openReadStreamSync`), so the sealer can bind the
          // frame count into every frame's AAD while never buffering more than
          // one frame.
          const source = remote.encryptKey
            ? opened.stream.pipe(
                sealBlobStream(remote.encryptKey, sha, opened.size, remote.frameSize),
              )
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
    await remote.store.put(
      sha,
      remote.encryptKey ? sealBlob(remote.encryptKey, sha, bytes, remote.frameSize) : bytes,
    );
    return true;
  }

  /**
   * The reconciliation sweep (issue #296 §6): remote list vs the live sha set.
   * Orphans delete; missing replicas re-push; shas absent from BOTH tiers are
   * reported, never invented. Records `sweepStatus()` around the try/catch so
   * the `blob-sweep` health probe can read the last outcome; the original throw
   * still propagates (`VaultPlane.runSweep` catches it to log a warning).
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
    // The deep pass DOES list the whole remote (issue #405 §4) — its job, and it
    // heals the index below; only `statusFor`/`replicate` avoid the listing.
    const remoteShas = remote ? new Set(await remote.store.list()) : new Set<string>();
    const survivingRemote = new Set(remoteShas);
    if (remote) {
      for (const sha of remoteShas) {
        if (liveShas.has(sha)) continue;
        if (options.skipOrphanDelete) {
          result.orphansSkipped.push(sha);
          continue;
        }
        await remote.store.delete(sha);
        survivingRemote.delete(sha);
        this.cache?.replica.unmark(sha);
        result.orphansDeleted.push(sha);
      }
    }
    // Heal the replication index against the real remote listing (issue #405
    // §4): the listing is TRUTH, the index a cache of evidence.
    if (this.cache && remote) {
      this.cache.replica.heal(survivingRemote, (sha) => this.local.statSync(sha)?.size ?? 0);
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
      for (const sha of shas) {
        await remote.store.delete(sha);
        this.cache?.replica.unmark(sha);
      }
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
    // Issue #405 §4: consult the durable replication INDEX (healed by the deep
    // `reconcile()` pass), not a live `remote.list()` — a full listing is 100+
    // round trips per sweep at 500 GB, and this runs every refreshCustodyState.
    // Only when no cache is wired (legacy) do we list.
    const remoteShas = this.cache
      ? this.cache.replica.all()
      : remote
        ? new Set(await remote.store.list())
        : null;
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
   * Copy every resident local blob into `destDir/blobs` — the self-contained
   * export/backup gesture (issue #296 §6). Delegates to custody-export.ts so
   * the facade stays under the line-cap.
   */
  exportTo(destDir: string): { copied: number } {
    return exportLocalTier(this.local, destDir);
  }
}
