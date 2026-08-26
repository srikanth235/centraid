// Store-class routing (#425): `derived` is a BINARY display derivative that is
// not also an original; everything else is `cas`.

import type { DatabaseSync } from "node:sqlite";

import type { BackupPolicy } from "../backup-policy.js";
import type { RemoteTier } from "./custody-types.js";
import { storeForClass } from "./custody-types.js";
import { BINARY_DERIVATIVE_SQL } from "./derivatives.js";
import type { ReplicaStore } from "./replica-index.js";
import type { BlobStore } from "./store.js";

export const DERIVED_DIRECT_PUT_MAX_BYTES = 32 * 1024 * 1024;

export function desiredStoreForSha(
  db: DatabaseSync,
  sha256: string
): ReplicaStore {
  const original = db
    .prepare(
      `SELECT 1 AS present FROM core_content_item WHERE sha256 = ?
       UNION ALL
       SELECT 1 AS present FROM blob_staging WHERE sha256 = ? AND variant IS NULL
       LIMIT 1`
    )
    .get(sha256, sha256) as { present: 1 } | undefined;
  // Both an original and a derivative ⇒ cas: never strand a content item's bytes
  // on the derivatives prefix.
  if (original) return "cas";
  const derivative = db
    .prepare(
      `SELECT 1 AS present FROM core_content_derivative
        WHERE sha256 = ? AND variant IN (${BINARY_DERIVATIVE_SQL})
       UNION ALL
       SELECT 1 AS present FROM blob_staging
        WHERE sha256 = ? AND variant IN (${BINARY_DERIVATIVE_SQL})
       LIMIT 1`
    )
    .get(sha256, sha256) as { present: 1 } | undefined;
  return derivative ? "derived" : "cas";
}

/** The replica index MUST record the returned `storeClass` — it is where the
 *  bytes land. */
export function resolveWriteStore(
  remote: RemoteTier,
  desired: ReplicaStore,
  byteSize: number
): { store: BlobStore; storeClass: ReplicaStore } {
  const useDerived =
    desired === "derived" &&
    !!remote.derivedStore &&
    byteSize <= DERIVED_DIRECT_PUT_MAX_BYTES;
  const storeClass: ReplicaStore = useDerived ? "derived" : "cas";
  return { store: storeForClass(remote, storeClass), storeClass };
}

// --- Direct-to-cold heuristic for large media originals (#425) ---

export const COLD_ORIGINAL_STORAGE_CLASS = "STANDARD_IA";
export const DEFAULT_COLD_ORIGINAL_MIN_BYTES = 25 * 1024 * 1024;
export const DEFAULT_COLD_ORIGINAL_MIME_PREFIXES: readonly string[] = [
  "video/",
  "audio/",
];

export function originalMediaForSha(
  db: DatabaseSync,
  sha256: string
): { mediaType: string; byteSize: number } | null {
  const row = db
    .prepare(
      `SELECT media_type AS mediaType, byte_size AS byteSize
         FROM core_content_item WHERE sha256 = ?
       UNION ALL
       SELECT media_type AS mediaType, byte_size AS byteSize
         FROM blob_staging WHERE sha256 = ? AND variant IS NULL
       LIMIT 1`
    )
    .get(sha256, sha256) as { mediaType: string; byteSize: number } | undefined;
  return row ?? null;
}

export interface StorageClassForWriteInput {
  desiredStore: ReplicaStore;
  policy: BackupPolicy;
  supportedStorageClasses?: readonly string[];
  mediaType?: string;
  byteSize?: number;
}

export function resolveStorageClassForWrite(
  input: StorageClassForWriteInput
): string | undefined {
  const { desiredStore, policy, supportedStorageClasses, mediaType, byteSize } =
    input;
  if (desiredStore !== "cas") return undefined;
  // Empty/whitespace is unset, agreeing with db.ts and resolveBackupPolicy.
  if (policy.storageClass !== undefined && policy.storageClass.trim() !== "")
    return undefined;
  const knob = policy.directToColdOriginals;
  if (knob?.enabled === false) return undefined;
  if (!supportedStorageClasses?.includes(COLD_ORIGINAL_STORAGE_CLASS))
    return undefined;
  if (mediaType === undefined || byteSize === undefined) return undefined;
  if (byteSize < (knob?.minBytes ?? DEFAULT_COLD_ORIGINAL_MIN_BYTES))
    return undefined;
  const prefixes = knob?.mimePrefixes ?? DEFAULT_COLD_ORIGINAL_MIME_PREFIXES;
  if (!prefixes.some((prefix) => mediaType.startsWith(prefix)))
    return undefined;
  return COLD_ORIGINAL_STORAGE_CLASS;
}

/** `originalHint` stands in on the remote-primary ingress doors, where the CAS
 *  object is minted BEFORE the original row exists; the DB lookup wins. */
export function storageClassForShaWrite(
  db: DatabaseSync,
  sha256: string,
  storeClass: ReplicaStore,
  supportedStorageClasses: readonly string[] | undefined,
  policy: BackupPolicy,
  originalHint?: { mediaType: string; byteSize: number }
): string | undefined {
  if (storeClass !== "cas") return undefined;
  if (policy.storageClass !== undefined && policy.storageClass.trim() !== "")
    return undefined;
  if (policy.directToColdOriginals?.enabled === false) return undefined;
  if (!supportedStorageClasses?.includes(COLD_ORIGINAL_STORAGE_CLASS))
    return undefined;
  const media = originalMediaForSha(db, sha256) ?? originalHint;
  return resolveStorageClassForWrite({
    desiredStore: storeClass,
    policy,
    supportedStorageClasses,
    ...(media ? { mediaType: media.mediaType, byteSize: media.byteSize } : {}),
  });
}
