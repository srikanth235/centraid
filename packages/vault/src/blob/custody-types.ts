// Shared custody value types (issue #352 phase 3/4, #405 §3). Kept in their own
// leaf module so custody.ts and the custody-state.ts projection can both name
// them without a runtime import cycle, and so custody.ts (the facade) stays
// under the governance line-cap.

import type { BlobStore } from './store.js';

/**
 * Per-content custody state: whether a piece of content's ORIGINAL bytes sit
 * in the local tier, the remote tier, both, or (an integrity gap) neither.
 * `blob_custody_state` mirrors this per content_id (schema/blob.ts).
 */
export type CustodyState = 'local-only' | 'replicated' | 'remote-only' | 'missing';

/** How the host resolves the (settings-declared) remote tier on demand. */
export interface RemoteTier {
  store: BlobStore;
  /** Seal remote objects with this key (settings `blob_store.encrypt`). */
  encryptKey?: Buffer;
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
