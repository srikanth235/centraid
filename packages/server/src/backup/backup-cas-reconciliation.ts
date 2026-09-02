/*
 * Target-independent remote-CAS reconciliation (#414): models "backup not
 * configured, CAS configured" — never a fake backup target.
 */

import {
  ReplicaIndex,
  archivedSegmentShas,
  conversationArchiveShas,
  liveBlobShasCached,
} from "@centraid/vault";
import type { VaultDb } from "@centraid/vault";

import { collectCasInventory } from "./backup-cas-inventory.js";
import type { CasInventoryResult } from "./backup-cas-inventory.js";
import { reconcileDerivedInto } from "./backup-derived-inventory.js";
import { unavailableStore } from "./backup-reconciliation-state.js";
import type { StoreReconciliationState } from "./backup-reconciliation-state.js";
import { reconcileCasInventory } from "./backup-reconciliation.js";
import type { BackupReconciliationState } from "./backup-reconciliation.js";
import type { StorageConnectionStore } from "./storage-connections.js";

const SAMPLE_LIMIT = 25;

function statusForCas(
  cas: StoreReconciliationState
): BackupReconciliationState["status"] {
  if (
    (cas.configured && !!cas.error) ||
    cas.missing.count > 0 ||
    (cas.attestationDrift?.providerOnly.count ?? 0) > 0 ||
    (cas.attestationDrift?.metadataMismatch.count ?? 0) > 0
  ) {
    return "error";
  }
  if (
    cas.orphans.count > 0 ||
    !!cas.attestationError ||
    (cas.attestationDrift?.bucketOnly.count ?? 0) > 0
  ) {
    return "degraded";
  }
  return "ok";
}

function addAuthenticatedFailures(
  cas: StoreReconciliationState,
  failures: readonly string[]
): void {
  if (failures.length === 0) return;
  const failureSet = new Set(failures);
  cas.missing = {
    count: cas.missing.count + failureSet.size,
    sample: [...new Set([...cas.missing.sample, ...failureSet])]
      .sort()
      .slice(0, SAMPLE_LIMIT),
  };
}

export interface CasOnlyReconciliationOptions {
  db: VaultDb;
  storageConnections?: StorageConnectionStore;
  verifyBucket: boolean;
  checkedAt: string;
  collect?: typeof collectCasInventory;
}

/** Persistable failure shape, honest about the absent backup store. */
export function failedCasOnlyReconciliation(
  checkedAt: string,
  mode: BackupReconciliationState["mode"],
  error: string
): BackupReconciliationState {
  return {
    checkedAt,
    mode,
    status: "error",
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
    audit: { source: "unavailable", eventCount: 0, recent: [] },
  };
}

/** Reconcile remote CAS custody without requiring a backup target. */
export async function runCasOnlyReconciliation(
  opts: CasOnlyReconciliationOptions
): Promise<BackupReconciliationState> {
  const collect = opts.collect ?? collectCasInventory;
  const result: CasInventoryResult = await collect({
    db: opts.db,
    ...(opts.storageConnections
      ? { storageConnections: opts.storageConnections }
      : {}),
    verifyBucket: opts.verifyBucket,
  });
  let cas = unavailableStore(result.configured, result.error);
  if (result.collection) {
    // Live GC roots (#436) = liveBlobShas ∪ archivedSegmentShas ∪ retained-
    // snapshot roots — third term provably EMPTY here (no backup store ⇒ no
    // manifests; the configured fork lives in `runBackupReconciliation`). The
    // base set is SHARED/read-only (#659): union into a local copy, never
    // mutate it.
    const live = new Set(liveBlobShasCached(opts.db.vault));
    for (const sha of archivedSegmentShas(opts.db.vault)) live.add(sha);
    for (const sha of conversationArchiveShas(opts.db.vault)) live.add(sha);
    const index = new ReplicaIndex(opts.db.vault);
    for (const sha of result.authenticatedFailures ?? []) index.unmark(sha);
    // Scope the cas diff to `store='cas'` rows (#425).
    const rows = index.rows().filter((row) => row.store === "cas");
    cas = reconcileCasInventory({
      collection: result.collection,
      live,
      indexed: new Set(rows.map((row) => row.sha256)),
      recentlyIndexed: new Set(
        rows
          .filter((row) => row.replicatedAt >= opts.checkedAt)
          .map((row) => row.sha256)
      ),
      unmark: (sha) => index.unmark(sha),
    });
    addAuthenticatedFailures(cas, result.authenticatedFailures ?? []);
    // Fold the derived store class's drift into `cas` via the same collect seam.
    await reconcileDerivedInto({
      cas,
      db: opts.db,
      ...(opts.storageConnections
        ? { storageConnections: opts.storageConnections }
        : {}),
      verifyBucket: opts.verifyBucket,
      live,
      checkedAt: opts.checkedAt,
      ...(opts.collect ? { collect: opts.collect } : {}),
    });
  }

  return {
    checkedAt: opts.checkedAt,
    mode: opts.verifyBucket ? "bucket" : "scheduled",
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
    audit: { source: "unavailable", eventCount: 0, recent: [] },
  };
}
