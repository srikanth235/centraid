// Blob replication store-class routing (issue #425 Wave 2 Part A). The
// replication layer is SHA-only — the remote key is `{prefix}blobs/sha256/{sha}`
// and the prefix comes from whichever `S3BlobStore` the write path picks. This
// module is the single place that decides, purely from the vault's own model,
// WHICH store class a sha's bytes belong in:
//
//   `derived` — the sha is a BINARY display derivative (thumb/preview/poster)
//               and NOT also an original. These are reconstructible convenience
//               bytes; a target that grants the `derived` store takes them off
//               the durable `cas` prefix.
//   `cas`     — everything else: originals, snapshot chunks, outbox promotion,
//               and the dedup edge where one sha is BOTH an original and a
//               derivative (original custody wins — `derived` is only an
//               optimization, never the sole home of bytes a content item owns).
//
// Semantic contributions (text/transcript/embedding/phash/thumbhash) never reach
// here: they live inline and are never enqueued for replication (staging.ts only
// records a local receipt for binary variants). So this only ever sees shas that
// have a real CAS object.

import type { DatabaseSync } from 'node:sqlite';
import type { BackupPolicy } from '../backup-policy.js';
import { BINARY_DERIVATIVE_SQL } from './derivatives.js';
import type { RemoteTier } from './custody-types.js';
import { storeForClass } from './custody-types.js';
import type { BlobStore } from './store.js';
import type { ReplicaStore } from './replica-index.js';

/**
 * Binary derivatives that never take the multipart/streaming path stay under
 * this ceiling (preview/poster cap at 16 MiB in the registry), so a `derived`
 * write is always a single direct PUT. A sha whose bytes exceed this — which a
 * legitimate binary derivative never does — falls back to `cas` at write time
 * (see `resolveWriteStore`) rather than growing a parallel transfer store under
 * the derived prefix.
 */
export const DERIVED_DIRECT_PUT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * The store class a sha's bytes belong in, decided from the vault model alone.
 * `derived` iff the sha appears as a binary derivative (a `core_content_derivative`
 * row with a binary variant, or a `blob_staging` row with a binary variant) AND
 * does NOT also appear as an original (a `core_content_item.sha256`, or a
 * `blob_staging` original row with `variant IS NULL`). Both enqueue-side rows
 * are written before the local receipt that drives replication, so this
 * drain-time lookup is race-safe.
 */
export function desiredStoreForSha(db: DatabaseSync, sha256: string): ReplicaStore {
  const original = db
    .prepare(
      `SELECT 1 AS present FROM core_content_item WHERE sha256 = ?
       UNION ALL
       SELECT 1 AS present FROM blob_staging WHERE sha256 = ? AND variant IS NULL
       LIMIT 1`,
    )
    .get(sha256, sha256) as { present: 1 } | undefined;
  // Original custody wins the dedup edge: a sha that is both an original and a
  // derivative stays on cas, so a content item's bytes are never stranded on the
  // reconstructible-derivatives prefix.
  if (original) return 'cas';
  const derivative = db
    .prepare(
      `SELECT 1 AS present FROM core_content_derivative
        WHERE sha256 = ? AND variant IN (${BINARY_DERIVATIVE_SQL})
       UNION ALL
       SELECT 1 AS present FROM blob_staging
        WHERE sha256 = ? AND variant IN (${BINARY_DERIVATIVE_SQL})
       LIMIT 1`,
    )
    .get(sha256, sha256) as { present: 1 } | undefined;
  return derivative ? 'derived' : 'cas';
}

/**
 * Resolve the actual `BlobStore` + recorded store class for a write, applying
 * graceful degradation (issue #425 Wave 2):
 *   - `desired === 'derived'` routes to the derived store ONLY when the tier has
 *     one AND the payload fits a single direct PUT; otherwise it falls back to
 *     `cas` (a tier without a derived grant, or an implausibly large "derivative").
 *   - `desired === 'cas'` always uses the cas store.
 * The returned `storeClass` is what the replica index MUST record — it always
 * matches where the bytes actually land, so restore/reconcile read the right
 * prefix.
 */
export function resolveWriteStore(
  remote: RemoteTier,
  desired: ReplicaStore,
  byteSize: number,
): { store: BlobStore; storeClass: ReplicaStore } {
  const useDerived =
    desired === 'derived' && !!remote.derivedStore && byteSize <= DERIVED_DIRECT_PUT_MAX_BYTES;
  const storeClass: ReplicaStore = useDerived ? 'derived' : 'cas';
  return { store: storeForClass(remote, storeClass), storeClass };
}

// --- Direct-to-cold heuristic for large media originals (issue #425 Wave 3) ---

/** The cold storage class an eligible original's object-creating write carries. */
export const COLD_ORIGINAL_STORAGE_CLASS = 'STANDARD_IA';
/** Default size floor: below this an original stays class-less (Standard). */
export const DEFAULT_COLD_ORIGINAL_MIN_BYTES = 25 * 1024 * 1024;
/** Default MIME prefixes — video/audio only (images/stills stay warm in v0). */
export const DEFAULT_COLD_ORIGINAL_MIME_PREFIXES: readonly string[] = ['video/', 'audio/'];

/**
 * Media type + byte size for a sha IFF it is an ORIGINAL (mirrors
 * `desiredStoreForSha`'s original detection: a `core_content_item` row, or a
 * `blob_staging` original row with `variant IS NULL`). Returns null for anything
 * that is not an original — a binary derivative, or a snapshot/WAL sha with no
 * `core_content_item` row — which makes those ineligible for the direct-to-cold
 * heuristic by construction (an archived WAL segment sha in the cas store has no
 * content row, so it never matches).
 */
export function originalMediaForSha(
  db: DatabaseSync,
  sha256: string,
): { mediaType: string; byteSize: number } | null {
  const row = db
    .prepare(
      `SELECT media_type AS mediaType, byte_size AS byteSize
         FROM core_content_item WHERE sha256 = ?
       UNION ALL
       SELECT media_type AS mediaType, byte_size AS byteSize
         FROM blob_staging WHERE sha256 = ? AND variant IS NULL
       LIMIT 1`,
    )
    .get(sha256, sha256) as { mediaType: string; byteSize: number } | undefined;
  return row ?? null;
}

export interface StorageClassForWriteInput {
  /** Where the bytes actually land — only `cas` is ever eligible. */
  desiredStore: ReplicaStore;
  policy: BackupPolicy;
  /** The target's declared class list; absent ⇒ heuristic never engages. */
  supportedStorageClasses?: readonly string[];
  /** The sha's media type + size, when it is an original (else omit both). */
  mediaType?: string;
  byteSize?: number;
}

/**
 * The S3 storage class an eligible original's object-creating write should carry
 * (issue #425 Wave 3 Part B), or undefined to leave the write class-less
 * (Standard / the instance-level `BackupPolicy.storageClass`). Pure and
 * unit-testable. Returns `STANDARD_IA` ONLY when ALL hold:
 *   - `desiredStore === 'cas'` (never a derived write — those are read-hot),
 *   - the heuristic is enabled (default ON; absent knob ⇒ enabled),
 *   - no explicit vault-level `storageClass` is set (that wins — the instance
 *     store already applies it to every write, so the heuristic stands down),
 *   - the target's declared list includes `STANDARD_IA`,
 *   - the sha is an original with a media type matching a configured prefix,
 *   - its size is at or above the configured floor.
 */
export function resolveStorageClassForWrite(input: StorageClassForWriteInput): string | undefined {
  const { desiredStore, policy, supportedStorageClasses, mediaType, byteSize } = input;
  if (desiredStore !== 'cas') return undefined;
  // An explicit vault-level class wins — but treat empty/whitespace as unset, in
  // agreement with db.ts (which reads it as a falsy header) and resolveBackupPolicy.
  if (policy.storageClass !== undefined && policy.storageClass.trim() !== '') return undefined;
  const knob = policy.directToColdOriginals;
  if (knob?.enabled === false) return undefined;
  if (!supportedStorageClasses?.includes(COLD_ORIGINAL_STORAGE_CLASS)) return undefined;
  if (mediaType === undefined || byteSize === undefined) return undefined;
  if (byteSize < (knob?.minBytes ?? DEFAULT_COLD_ORIGINAL_MIN_BYTES)) return undefined;
  const prefixes = knob?.mimePrefixes ?? DEFAULT_COLD_ORIGINAL_MIME_PREFIXES;
  if (!prefixes.some((prefix) => mediaType.startsWith(prefix))) return undefined;
  return COLD_ORIGINAL_STORAGE_CLASS;
}

/**
 * Resolve the write class for a sha in one call: look the sha up as an original
 * and run the heuristic. `storeClass` is where the bytes actually land — a
 * non-cas (derived) write is class-less by contract, so the lookup is skipped.
 * db.ts wires this onto `RemoteTier.storageClassFor`.
 *
 * `originalHint` (media type + size) stands in for the sha's original row on the
 * remote-primary ingress doors, where the CAS object is minted BEFORE the
 * `blob_staging` original row exists — without it a sha-only DB lookup is empty
 * at promote time and the heuristic never fires for the large media originals it
 * targets (they take the streaming path). The DB lookup wins when it finds a row
 * (the local-first replication path, whose row is already written); the hint is
 * only consulted on a miss, and streaming ingress is originals-only by contract.
 */
export function storageClassForShaWrite(
  db: DatabaseSync,
  sha256: string,
  storeClass: ReplicaStore,
  supportedStorageClasses: readonly string[] | undefined,
  policy: BackupPolicy,
  originalHint?: { mediaType: string; byteSize: number },
): string | undefined {
  // Cheap gates first — none of these need the sha's media row, so short-circuit
  // before the `originalMediaForSha` UNION query when the heuristic can't fire:
  // a non-cas write, an explicit vault-level class, the knob disabled, or a
  // target that never declared STANDARD_IA. Only an eligible write hits the DB.
  if (storeClass !== 'cas') return undefined;
  if (policy.storageClass !== undefined && policy.storageClass.trim() !== '') return undefined;
  if (policy.directToColdOriginals?.enabled === false) return undefined;
  if (!supportedStorageClasses?.includes(COLD_ORIGINAL_STORAGE_CLASS)) return undefined;
  const media = originalMediaForSha(db, sha256) ?? originalHint;
  return resolveStorageClassForWrite({
    desiredStore: storeClass,
    policy,
    supportedStorageClasses,
    ...(media ? { mediaType: media.mediaType, byteSize: media.byteSize } : {}),
  });
}
