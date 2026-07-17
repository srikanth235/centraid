// Shared custody value types (issue #352 phase 3/4, #405 §3). Kept in their own
// leaf module so custody.ts and the custody-state.ts projection can both name
// them without a runtime import cycle, and so custody.ts (the facade) stays
// under the governance line-cap.

import type { BlobStore } from './store.js';
import type { RemoteBlobTransfer } from './remote-transfer.js';
import type { ReplicaStore } from './replica-index.js';

/**
 * Per-content custody state: whether a piece of content's ORIGINAL bytes sit
 * in the local tier, the remote tier, both, or (an integrity gap) neither.
 * `blob_custody_state` mirrors this per content_id (schema/blob.ts).
 */
export type CustodyState =
  | 'pending-offsite'
  | 'local-only'
  | 'replicated'
  | 'remote-only'
  | 'missing';

/** How the host resolves the (settings-declared) remote tier on demand. */
export interface RemoteTier {
  store: BlobStore;
  /**
   * Optional second CAS-shaped store under the target's `derived` grant prefix
   * (issue #425 Wave 2). Present only when the vault's `blob_store` settings
   * carry a `derivedPrefix` (the target advertised + granted the `derived`
   * store); binary display derivatives (thumb/preview/poster) route here.
   * Absent ⇒ graceful degradation: derivatives replicate into `store` (cas),
   * byte-for-byte today's behavior. Shares the cas store's credentials/endpoint/
   * bucket — only the key prefix differs; it deliberately has NO transfer store
   * (derivatives are small, so they never take the multipart/streaming path).
   */
  derivedStore?: BlobStore;
  /** Durable multipart/temp-copy/direct-presign operations when supported. */
  transfer?: RemoteBlobTransfer;
  /**
   * Resolve the S3 storage class an eligible ORIGINAL's object-creating write
   * should carry (issue #425 Wave 3 Part B), or undefined to leave it class-less
   * (Standard / the instance-level class). db.ts wires this to the direct-to-cold
   * heuristic (large video/audio originals → STANDARD_IA, but only when the
   * target declares support). `storeClass` is where the bytes actually land —
   * the resolver returns undefined for anything but `cas`, so a derived write is
   * never demoted to cold. Absent (legacy unit tests) ⇒ every write stays
   * class-less, byte-for-byte pre-Wave-3 behavior.
   *
   * `originalHint` supplies the sha's media type + byte size for the
   * remote-primary ingress doors (streaming/direct promotion), where the object
   * is minted BEFORE its `blob_staging` original row is recorded — so a
   * sha-only DB lookup would still be empty and the heuristic would never fire
   * for exactly the large media originals it targets. When given, it stands in
   * for the (not-yet-written) original row; the local-first replication path
   * omits it and relies on the DB lookup, whose row already exists.
   */
  storageClassFor?: (
    sha256: string,
    storeClass: ReplicaStore,
    originalHint?: { mediaType: string; byteSize: number },
  ) => string | undefined;
  /** Seal remote objects with this key (settings `blob_store.encrypt`). */
  encryptKey?: Buffer;
  /** Per-blob edge-seal key; takes precedence over the legacy shared key. */
  keyFor?: (sha256: string) => Buffer;
  /**
   * Plaintext frame size for the framed seal (issue #405 §1). Optional so
   * db.ts can construct a `RemoteTier` without it (falls back to the format
   * default); tests inject a small value to exercise multi-frame blobs
   * without allocating multi-MiB buffers. Only the WRITER (replication) reads
   * this — a reader takes the frame size from the object's own directory.
   */
  frameSize?: number;
  /**
   * Blobs at or above this byte size stream (issue #367 §C8) instead of
   * buffering. Optional; absent = the module default. Tests set it to 0 to
   * force the streaming seal path over a tiny blob.
   */
  streamThresholdBytes?: number;
}

/** Resolve the encryption key without making every custody caller key-aware. */
export function remoteEncryptionKey(remote: RemoteTier, sha256: string): Buffer | undefined {
  return remote.keyFor?.(sha256) ?? remote.encryptKey;
}

/**
 * The `BlobStore` that holds (or should hold) `store`-classed bytes (issue #425
 * Wave 2). `derived` resolves to `remote.derivedStore` when it exists; anything
 * else — or a tier with no derived store — falls back to the cas `store`, which
 * is the graceful-degradation contract (a provider without `derived` keeps
 * everything under cas). The edge-seal key is per-sha and store-independent, so
 * only the object prefix changes with the store class.
 */
export function storeForClass(remote: RemoteTier, store: 'cas' | 'derived'): BlobStore {
  return store === 'derived' && remote.derivedStore ? remote.derivedStore : remote.store;
}

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
  /**
   * Orphaned remote objects HELD by the orphan-grace window (issue #439 R4):
   * found orphaned but tombstoned (or newly tombstoned) less than `graceWindowMs`
   * ago, so a recovery-to-N that lands between two snapshots can still reach the
   * byte. Distinct from `orphansSkipped` (a lease-conflict pause of the whole
   * delete phase): grace-held orphans WILL delete on a future sweep once their
   * grace elapses. Empty when no grace window is in force.
   */
  orphansGraceHeld: string[];
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
  /**
   * Retained-snapshot GC roots (issue #436 §6 — the GC-pins-snapshots
   * invariant). Blob shas referenced by any RETAINED backup snapshot manifest
   * that the caller has authenticated. A remote object one of these names is
   * NEVER an orphan, even when the live vault model no longer references it:
   * CAS keeps no history of its own, so a past-but-retained snapshot's
   * reference IS the only record that the byte is still needed for a
   * recovery-to-N. Deleting it would silently break the recovery window for
   * exactly the attachments users care most about. The caller (the gateway
   * layer that owns the backup provider) computes this set; whenever it cannot
   * prove reachability it MUST fail safe by also setting `skipOrphanDelete`
   * rather than passing an incomplete set.
   */
  extraLiveRoots?: ReadonlySet<string>;
  /**
   * The orphan-grace window in ms (issue #439 R4 — the recovery window N, the
   * retention daily rung). When set, a genuine orphan (not live, not pinned by
   * `extraLiveRoots`) is not deleted on the pass that first finds it: the sweep
   * tombstones it (`ctx.orphans`) and DEFERS the delete until
   * `now - first_orphaned_at > graceWindowMs`. This makes the recovery-window
   * number N honest for a blob created and dereferenced BETWEEN two snapshots —
   * named by no retained manifest, yet exactly what a PITR into that interval
   * replays. Undefined ⇒ grace disengaged (immediate delete, the pre-R4
   * behavior) — correct only when there is no recovery window to protect (a
   * local-only vault). The gateway sweep passes `Number.POSITIVE_INFINITY` as a
   * fail-safe when N SHOULD exist but could not be resolved, so nothing deletes.
   */
  graceWindowMs?: number;
  /**
   * Monotonic clock for the grace-window arithmetic (issue #439 R4), injectable
   * so tests need no real waits. Absent ⇒ `Date.now`.
   */
  now?: () => number;
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
