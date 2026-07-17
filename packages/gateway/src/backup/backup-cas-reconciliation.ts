/*
 * Target-independent remote-CAS reconciliation (issue #414 D14).
 *
 * A vault may keep its primary bytes in provider/BYO S3 without configuring
 * the separate snapshot-backup store. This pass deliberately models that as
 * "backup not configured, CAS configured" instead of minting a fake backup
 * target merely so inventory can run.
 */

import { ReplicaIndex, archivedSegmentShas, liveBlobShas, type VaultDb } from '@centraid/vault';
import { collectCasInventory, type CasInventoryResult } from './backup-cas-inventory.js';
import { reconcileDerivedInto } from './backup-derived-inventory.js';
import { reconcileCasInventory, type BackupReconciliationState } from './backup-reconciliation.js';
import { unavailableStore, type StoreReconciliationState } from './backup-reconciliation-state.js';
import type { StorageConnectionStore } from './storage-connections.js';

const SAMPLE_LIMIT = 25;

function statusForCas(cas: StoreReconciliationState): BackupReconciliationState['status'] {
  if (
    (cas.configured && !!cas.error) ||
    cas.missing.count > 0 ||
    (cas.attestationDrift?.providerOnly.count ?? 0) > 0 ||
    (cas.attestationDrift?.metadataMismatch.count ?? 0) > 0
  ) {
    return 'error';
  }
  if (
    cas.orphans.count > 0 ||
    !!cas.attestationError ||
    (cas.attestationDrift?.bucketOnly.count ?? 0) > 0
  ) {
    return 'degraded';
  }
  return 'ok';
}

function addAuthenticatedFailures(
  cas: StoreReconciliationState,
  failures: readonly string[],
): void {
  if (failures.length === 0) return;
  const failureSet = new Set(failures);
  cas.missing = {
    count: cas.missing.count + failureSet.size,
    sample: [...new Set([...cas.missing.sample, ...failureSet])].sort().slice(0, SAMPLE_LIMIT),
  };
}

export interface CasOnlyReconciliationOptions {
  db: VaultDb;
  storageConnections?: StorageConnectionStore;
  verifyBucket: boolean;
  checkedAt: string;
  /** Deterministic collection seam for focused service tests. */
  collect?: typeof collectCasInventory;
}

/** Persistable failure shape that remains honest about the absent backup store. */
export function failedCasOnlyReconciliation(
  checkedAt: string,
  mode: BackupReconciliationState['mode'],
  error: string,
): BackupReconciliationState {
  return {
    checkedAt,
    mode,
    status: 'error',
    backup: unavailableStore(false),
    cas: unavailableStore(true, error),
    walGaps: { count: 0, sample: [] },
    walCoverage: {
      earliestTickMs: null,
      latestTickMs: null,
      spanDays: null,
      segmentCount: 0,
      markerCount: 0,
    },
    snapshots: { live: 0, pruned: 0, recent: [] },
    audit: { source: 'unavailable', eventCount: 0, recent: [] },
  };
}

/** Reconcile remote CAS custody without requiring or creating a backup target. */
export async function runCasOnlyReconciliation(
  opts: CasOnlyReconciliationOptions,
): Promise<BackupReconciliationState> {
  const collect = opts.collect ?? collectCasInventory;
  const result: CasInventoryResult = await collect({
    db: opts.db,
    ...(opts.storageConnections ? { storageConnections: opts.storageConnections } : {}),
    verifyBucket: opts.verifyBucket,
  });
  let cas = unavailableStore(result.configured, result.error);
  if (result.collection) {
    // Live GC roots = liveBlobShas ∪ archivedSegmentShas ∪ retained-snapshot
    // roots (issue #436 §6). The third term is provably EMPTY on this path:
    // `runCasOnlyReconciliation` runs ONLY when no backup store/provider is
    // configured (see BackupService.doRunReconciliation), so no snapshot
    // manifest exists to reference a blob — there is nothing to open and no
    // recovery window to protect. When a backup store IS configured, the
    // reconciliation runs through `runBackupReconciliation`, which computes the
    // root set from the provider's retained manifests. Kept explicit so the
    // invariant is visible at both forks of the diff, not silently absent here.
    const live = liveBlobShas(opts.db.vault);
    for (const sha of archivedSegmentShas(opts.db.journal)) live.add(sha);
    const index = new ReplicaIndex(opts.db.vault);
    for (const sha of result.authenticatedFailures ?? []) index.unmark(sha);
    // Scope the cas diff to `store='cas'` rows (issue #425 Wave 2).
    const rows = index.rows().filter((row) => row.store === 'cas');
    cas = reconcileCasInventory({
      collection: result.collection,
      live,
      indexed: new Set(rows.map((row) => row.sha256)),
      recentlyIndexed: new Set(
        rows.filter((row) => row.replicatedAt >= opts.checkedAt).map((row) => row.sha256),
      ),
      unmark: (sha) => index.unmark(sha),
    });
    addAuthenticatedFailures(cas, result.authenticatedFailures ?? []);
    // Diff the derived store class too, folding its drift into `cas`. The same
    // `collect` seam drives it — a test's injected collector switches on `store`.
    await reconcileDerivedInto({
      cas,
      db: opts.db,
      ...(opts.storageConnections ? { storageConnections: opts.storageConnections } : {}),
      verifyBucket: opts.verifyBucket,
      live,
      checkedAt: opts.checkedAt,
      ...(opts.collect ? { collect: opts.collect } : {}),
    });
  }

  return {
    checkedAt: opts.checkedAt,
    mode: opts.verifyBucket ? 'bucket' : 'scheduled',
    status: statusForCas(cas),
    backup: unavailableStore(false),
    cas,
    walGaps: { count: 0, sample: [] },
    walCoverage: {
      earliestTickMs: null,
      latestTickMs: null,
      spanDays: null,
      segmentCount: 0,
      markerCount: 0,
    },
    snapshots: { live: 0, pruned: 0, recent: [] },
    audit: { source: 'unavailable', eventCount: 0, recent: [] },
  };
}
