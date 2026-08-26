// Shared custody value types (#352, #405 §3). A leaf module so custody.ts and
// custody-state.ts can name them without a runtime import cycle.

import type { RemoteBlobTransfer } from "./remote-transfer.js";
import type { ReplicaStore } from "./replica-index.js";
import type { BlobStore } from "./store.js";

/** Mirrored per content_id in `blob_custody_state` (schema/blob.ts). */
export type CustodyState =
  | "pending-offsite"
  | "local-only"
  | "replicated"
  | "remote-only"
  | "missing";

export interface RemoteTier {
  store: BlobStore;
  /** Display derivatives route here (#425); absent ⇒ they fall back to `store`. */
  derivedStore?: BlobStore;
  transfer?: RemoteBlobTransfer;
  /**
   * Must return undefined for anything but `cas` so a derived write is never
   * demoted to cold (#425). `originalHint` stands in for the not-yet-written
   * `blob_staging` row on the remote-primary ingress doors.
   */
  storageClassFor?: (
    sha256: string,
    storeClass: ReplicaStore,
    originalHint?: { mediaType: string; byteSize: number }
  ) => string | undefined;
  /** Legacy shared seal key (settings `blob_store.encrypt`). */
  encryptKey?: Buffer;
  /** Per-blob edge-seal key; takes precedence over the legacy shared key. */
  keyFor?: (sha256: string) => Buffer;
  /** Framed-seal plaintext frame size (#405). Only the WRITER reads it. */
  frameSize?: number;
  /** Blobs at or above this size stream instead of buffering (#367). */
  streamThresholdBytes?: number;
}

export function remoteEncryptionKey(
  remote: RemoteTier,
  sha256: string
): Buffer | undefined {
  return remote.keyFor?.(sha256) ?? remote.encryptKey;
}

/** Falls back to cas when no derived store exists — graceful degradation (#425). */
export function storeForClass(
  remote: RemoteTier,
  store: "cas" | "derived"
): BlobStore {
  return store === "derived" && remote.derivedStore
    ? remote.derivedStore
    : remote.store;
}

export interface ReconcileResult {
  orphansDeleted: string[];
  replicated: string[];
  /** Missing from BOTH tiers — an integrity error. */
  missing: string[];
  /** Orphans spared because the caller passed `skipOrphanDelete` (#367 §C6). */
  orphansSkipped: string[];
  /** Held by the grace window (#439); these WILL delete on a later sweep. */
  orphansGraceHeld: string[];
}

export interface ReconcileOptions {
  /** Skip the orphan-DELETE phase (#367): under a conflicted instance lease an
   *  unrecognized object may be the other live process's write. */
  skipOrphanDelete?: boolean;
  /**
   * Retained-snapshot GC roots (#436 §6): named here is NEVER an orphan, even
   * when the live model no longer references it. A caller that cannot prove
   * reachability MUST also set `skipOrphanDelete` rather than pass a partial set.
   */
  extraLiveRoots?: ReadonlySet<string>;
  /**
   * Orphan-grace window in ms (#439 R4): an orphan is tombstoned, not deleted,
   * until `now - first_orphaned_at > graceWindowMs`. Undefined ⇒ immediate
   * delete, correct only with no recovery window to protect. Pass
   * `Number.POSITIVE_INFINITY` as the fail-safe when it cannot be resolved.
   */
  graceWindowMs?: number;
  /** Absent ⇒ `Date.now`. */
  now?: () => number;
}

/** Sweep liveness (#351, #367). In-memory only: rebuildable, not durable. */
export interface BlobSweepStatus {
  lastCompletedAt: string | null;
  /** The backoff clock: `lastCompletedAt` only moves on success. */
  lastAttemptedAt: string | null;
  lastError: string | null;
  /** Consecutive failures — the `blob-sweep` probe's persistent/transient line. */
  consecutiveFailures: number;
}
