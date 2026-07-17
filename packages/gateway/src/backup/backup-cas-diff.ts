/*
 * The remote-CAS inventory diff primitive (issue #414 D14), split out of
 * backup-reconciliation.ts so the one CAS-vs-model comparison is shared,
 * verbatim, by every reconciliation fork: the backup-configured pass
 * (`runBackupReconciliation`), the BYO-S3 pass (`runCasOnlyReconciliation`),
 * and the derived-store diff. Observe-and-report only — its sole mutation is
 * the safety-critical demotion of stale replica evidence via `unmark`.
 */

import type { ProviderInventoryObject } from '@centraid/backup';
import type { CollectedInventory } from './backup-provider-observability.js';
import type {
  InventoryAttestationDrift,
  StoreReconciliationState,
} from './backup-reconciliation-state.js';
import { driftSummary as drift } from './backup-reconciliation-state.js';

function inventoryNumbers(objects: readonly ProviderInventoryObject[]): {
  objectCount: number;
  bytes: number;
  liveObjectCount: number;
  softDeletedCount: number;
  softDeletedBytes: number;
} {
  const objectCount = objects.length;
  let bytes = 0;
  let liveObjectCount = 0;
  let softDeletedCount = 0;
  let softDeletedBytes = 0;
  for (const object of objects) {
    bytes += object.sizeBytes;
    if (object.state === 'soft-deleted') {
      softDeletedCount += 1;
      softDeletedBytes += object.sizeBytes;
      continue;
    }
    liveObjectCount += 1;
  }
  return { objectCount, bytes, liveObjectCount, softDeletedCount, softDeletedBytes };
}

function attestationDrift(collection: CollectedInventory): InventoryAttestationDrift | undefined {
  if (!collection.crossCheck) return undefined;
  return {
    providerOnly: drift(collection.crossCheck.providerOnly),
    bucketOnly: drift(collection.crossCheck.bucketOnly),
    metadataMismatch: drift(collection.crossCheck.metadataMismatch),
  };
}

export function baseStore(
  collection: CollectedInventory,
  missing: Iterable<string>,
  orphans: Iterable<string>,
): StoreReconciliationState {
  return {
    configured: true,
    source: collection.source,
    providerAttested: collection.providerAttested,
    ...inventoryNumbers(collection.objects),
    missing: drift(missing),
    orphans: drift(orphans),
    ...(attestationDrift(collection) ? { attestationDrift: attestationDrift(collection) } : {}),
    ...(collection.attestationError ? { attestationError: collection.attestationError } : {}),
  };
}

function casSha(key: string): string | undefined {
  return /(?:^|\/)blobs\/(?:sha256\/)?([0-9a-f]{64})$/.exec(key)?.[1];
}

/**
 * Diff remote CAS truth against both the live model and durable replica
 * evidence. `unmark` calls happen synchronously before this function returns:
 * the next cache eviction cannot rely on an object the inventory did not see.
 */
export function reconcileCasInventory(opts: {
  collection: CollectedInventory;
  live: Set<string>;
  indexed: Set<string>;
  unmark: (sha: string) => void;
  /** Marks created after inventory began cannot be disproved by that listing. */
  recentlyIndexed?: ReadonlySet<string>;
  /** Retained-snapshot GC roots (#436 §6): never orphans; absent-from-remote ⇒ critical missing. */
  snapshotReferenced?: ReadonlySet<string>;
}): StoreReconciliationState {
  const remote = new Set<string>();
  const unknownKeys: string[] = [];
  for (const object of opts.collection.objects) {
    if (object.state !== 'live') continue;
    const sha = casSha(object.key);
    if (sha) remote.add(sha);
    else unknownKeys.push(object.key);
  }
  const missing = [...opts.indexed].filter(
    (sha) => !remote.has(sha) && !opts.recentlyIndexed?.has(sha),
  );
  for (const sha of missing) opts.unmark(sha);
  // A retained-snapshot root absent from the remote folds into `missing`
  // (→ 'error'/CRITICAL, per #414 D14); a pure root has no index row to demote.
  const snapshotMissing = [...(opts.snapshotReferenced ?? [])].filter(
    (sha) => !remote.has(sha) && !opts.recentlyIndexed?.has(sha),
  );
  const allMissing = [...new Set([...missing, ...snapshotMissing])];
  // Snapshot roots pin against the orphan diff only (the shared `live` that
  // feeds the derived diff is untouched).
  const orphans = [...remote].filter(
    (sha) => !opts.live.has(sha) && !opts.snapshotReferenced?.has(sha),
  );
  return baseStore(opts.collection, allMissing, [...orphans, ...unknownKeys]);
}
