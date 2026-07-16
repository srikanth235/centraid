/*
 * Non-destructive backup/CAS inventory reconciliation (issue #414 D14).
 * This pass only observes and reports remote drift. Its sole mutation is the
 * safety-critical demotion of stale blob_replica evidence; it never deletes an
 * orphan and never repairs the provider, keeping the owner-facing audit honest.
 */

import {
  openManifest,
  parseWalCloserKey,
  parseWalPairMarkerKey,
  parseWalSegmentKey,
  walPairMarkerKey,
  type BackupProvider,
  type Keyring,
  type ProviderInventoryObject,
  type SnapshotRow,
  type WalDbName,
  type WalGroupCloser,
  type WalSegmentAddress,
} from '@centraid/backup';
import { ReplicaIndex, archivedSegmentShas, liveBlobShas, type VaultDb } from '@centraid/vault';
import type { StorageConnectionStore } from './storage-connections.js';
import { collectCasInventory } from './backup-cas-inventory.js';
import {
  collectAudit,
  collectInventory,
  type CollectedAudit,
  type CollectedInventory,
} from './backup-provider-observability.js';
import type {
  BackupReconciliationState,
  DriftSummary,
  InventoryAttestationDrift,
  StoreReconciliationState,
} from './backup-reconciliation-state.js';
import { driftSummary as drift, unavailableStore } from './backup-reconciliation-state.js';

export type {
  BackupReconciliationState,
  DriftSummary,
  InventoryAttestationDrift,
  StoreReconciliationState,
} from './backup-reconciliation-state.js';
export { failedReconciliation } from './backup-reconciliation-state.js';

const SAMPLE_LIMIT = 25;

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

function baseStore(
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
}): StoreReconciliationState {
  const remote = new Set<string>();
  const unknownKeys: string[] = [];
  for (const object of opts.collection.objects) {
    if (object.state !== 'live') continue;
    const sha = casSha(object.key);
    if (sha) remote.add(sha);
    else unknownKeys.push(object.key);
  }
  const missing = [...opts.indexed].filter((sha) => !remote.has(sha));
  for (const sha of missing) opts.unmark(sha);
  const orphans = [...remote].filter((sha) => !opts.live.has(sha));
  return baseStore(opts.collection, missing, [...orphans, ...unknownKeys]);
}

function walStreamGaps(
  db: WalDbName,
  generation: string,
  segments: readonly WalSegmentAddress[],
  closers: readonly WalGroupCloser[],
): string[] {
  const gaps: string[] = [];
  const relevantSegments = segments.filter((row) => row.db === db && row.generation === generation);
  const relevantClosers = closers.filter((row) => row.db === db && row.generation === generation);
  const groups = new Set<number>([
    ...relevantSegments.map((row) => row.group),
    ...relevantClosers.map((row) => row.group),
  ]);
  const orderedGroups = [...groups].sort((a, b) => a - b);
  if ((orderedGroups[0] ?? 0) > 0) gaps.push(`${db}/${generation}: starts-after-group-0`);
  for (const [index, group] of orderedGroups.entries()) {
    const previous = orderedGroups[index - 1];
    if (previous !== undefined && group !== previous + 1) {
      gaps.push(`${db}/${generation}: missing-group-between-${previous}-${group}`);
    }
    const rows = relevantSegments
      .filter((row) => row.group === group)
      .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
    const closer = relevantClosers.find((row) => row.group === group);
    if (rows.length === 0) {
      gaps.push(`${db}/${generation}/group-${group}: empty`);
      continue;
    }
    let offset = 0;
    for (const row of rows) {
      if (row.startOffset > offset) {
        gaps.push(`${db}/${generation}/group-${group}: ${offset}-${row.startOffset}`);
        break;
      }
      if (row.endOffset > offset) offset = row.endOffset;
    }
    if (closer && closer.endOffset !== offset) {
      gaps.push(`${db}/${generation}/group-${group}: closer-${closer.endOffset}-at-${offset}`);
    }
    if (index < orderedGroups.length - 1 && (!closer || closer.endOffset !== offset)) {
      gaps.push(`${db}/${generation}/group-${group}: next-group-without-complete-closer`);
    }
  }
  return gaps;
}

export function walInventoryGaps(keys: Iterable<string>, generations: Set<string>): string[] {
  const segments: WalSegmentAddress[] = [];
  const closers: WalGroupCloser[] = [];
  for (const key of keys) {
    const segment = parseWalSegmentKey(key);
    if (segment && generations.has(segment.generation)) segments.push(segment);
    const closer = parseWalCloserKey(key);
    if (closer && generations.has(closer.generation)) closers.push(closer);
  }
  const gaps: string[] = [];
  for (const generation of generations) {
    gaps.push(...walStreamGaps('vault', generation, segments, closers));
    gaps.push(...walStreamGaps('journal', generation, segments, closers));
  }
  return gaps;
}

export function walCoverageFromInventory(
  keys: Iterable<string>,
  generations: Set<string>,
): BackupReconciliationState['walCoverage'] {
  let earliestTickMs: number | null = null;
  let latestTickMs: number | null = null;
  let segmentCount = 0;
  let markerCount = 0;
  const observe = (tickMs: number): void => {
    earliestTickMs = earliestTickMs === null ? tickMs : Math.min(earliestTickMs, tickMs);
    latestTickMs = latestTickMs === null ? tickMs : Math.max(latestTickMs, tickMs);
  };
  for (const key of keys) {
    const segment = parseWalSegmentKey(key);
    if (segment && generations.has(segment.generation)) {
      segmentCount += 1;
      observe(segment.tickMs);
      continue;
    }
    const marker = parseWalPairMarkerKey(key);
    if (
      marker &&
      generations.has(marker.vaultGeneration) &&
      generations.has(marker.journalGeneration)
    ) {
      markerCount += 1;
      observe(marker.tickMs);
    }
  }
  return {
    earliestTickMs,
    latestTickMs,
    spanDays:
      earliestTickMs !== null && latestTickMs !== null
        ? (latestTickMs - earliestTickMs) / (24 * 60 * 60 * 1000)
        : null,
    segmentCount,
    markerCount,
  };
}

export function snapshotInventorySummary(
  rows: readonly SnapshotRow[],
): BackupReconciliationState['snapshots'] {
  return {
    live: rows.filter((row) => row.prunedAt === null).length,
    pruned: rows.filter((row) => row.prunedAt !== null).length,
    recent: [...rows]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, 50)
      .map((row) => ({
        seq: row.seq,
        totalBytes: row.totalBytes,
        objectCount: row.objectCount,
        createdAt: row.createdAt,
        prunedAt: row.prunedAt,
        format: row.format,
      })),
  };
}

async function analyzeBackupInventory(opts: {
  provider: BackupProvider;
  targetId: string;
  vaultId: string;
  keyring: Keyring;
  rows: SnapshotRow[];
  collection: CollectedInventory;
  walMarkerTips?: Record<string, number>;
}): Promise<{
  store: StoreReconciliationState;
  walGaps: DriftSummary;
  walCoverage: BackupReconciliationState['walCoverage'];
}> {
  const liveRows = opts.rows.filter((row) => row.prunedAt === null);
  const liveKeys = new Set(
    opts.collection.objects.filter((row) => row.state === 'live').map((row) => row.key),
  );
  const expected = new Set(liveRows.map((row) => row.manifestKey));
  const generations = new Set<string>();
  const expectedMarkerKeys = new Set<string>();
  const unreadable: string[] = [];
  const store = await opts.provider.openDataPlane(opts.targetId, 'backup', 'read');
  for (const row of liveRows) {
    if (!liveKeys.has(row.manifestKey)) continue;
    try {
      const manifest = openManifest(
        await store.get(row.manifestKey),
        opts.keyring,
        opts.vaultId,
        row.manifestHash,
      );
      for (const chunk of manifest.public.chunkIndex) expected.add(`chunks/${chunk.id}`);
      const vault = manifest.entries.find((entry) => entry.path === 'vault.db');
      const journal = manifest.entries.find((entry) => entry.path === 'journal.db');
      if (vault?.walGeneration) generations.add(vault.walGeneration);
      if (journal?.walGeneration) generations.add(journal.walGeneration);
      const tip = vault?.walTipTickMs ?? journal?.walTipTickMs;
      if (vault?.walGeneration && journal?.walGeneration && tip !== undefined) {
        expectedMarkerKeys.add(
          walPairMarkerKey({
            vaultGeneration: vault.walGeneration,
            journalGeneration: journal.walGeneration,
            tickMs: tip,
          }),
        );
      }
    } catch (err) {
      unreadable.push(`${row.manifestKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  for (const [pair, tickMs] of Object.entries(opts.walMarkerTips ?? {})) {
    const [vaultGeneration, journalGeneration] = [pair.slice(0, 32), pair.slice(33)];
    if (!vaultGeneration || !journalGeneration) continue;
    expectedMarkerKeys.add(walPairMarkerKey({ vaultGeneration, journalGeneration, tickMs }));
    generations.add(vaultGeneration);
    generations.add(journalGeneration);
  }
  const missing = [...expected].filter((key) => !liveKeys.has(key));
  const markerMissing = [...expectedMarkerKeys].filter((key) => !liveKeys.has(key));
  const orphans: string[] = [];
  for (const key of liveKeys) {
    if (expected.has(key)) continue;
    const segment = parseWalSegmentKey(key);
    if (segment && generations.has(segment.generation)) {
      continue;
    }
    const closer = parseWalCloserKey(key);
    if (closer && generations.has(closer.generation)) continue;
    const marker = parseWalPairMarkerKey(key);
    if (
      marker &&
      generations.has(marker.vaultGeneration) &&
      generations.has(marker.journalGeneration)
    ) {
      continue;
    }
    orphans.push(key);
  }
  const gaps = [
    ...markerMissing.map((key) => `missing confirmed marker ${key}`),
    ...walInventoryGaps(liveKeys, generations),
  ];
  return {
    store: baseStore(opts.collection, [...missing, ...unreadable], orphans),
    walGaps: drift(gaps),
    walCoverage: walCoverageFromInventory(liveKeys, generations),
  };
}

function statusFor(
  backup: StoreReconciliationState,
  cas: StoreReconciliationState,
  walGaps: DriftSummary,
  audit: CollectedAudit,
): BackupReconciliationState['status'] {
  const critical =
    !!backup.error ||
    (cas.configured && !!cas.error) ||
    backup.missing.count > 0 ||
    cas.missing.count > 0 ||
    walGaps.count > 0 ||
    (backup.attestationDrift?.providerOnly.count ?? 0) > 0 ||
    (cas.attestationDrift?.providerOnly.count ?? 0) > 0 ||
    (backup.attestationDrift?.metadataMismatch.count ?? 0) > 0 ||
    (cas.attestationDrift?.metadataMismatch.count ?? 0) > 0;
  if (critical) return 'error';
  const warning =
    backup.orphans.count > 0 ||
    cas.orphans.count > 0 ||
    !!backup.attestationError ||
    !!cas.attestationError ||
    !!audit.error ||
    (backup.attestationDrift?.bucketOnly.count ?? 0) > 0 ||
    (cas.attestationDrift?.bucketOnly.count ?? 0) > 0;
  return warning ? 'degraded' : 'ok';
}

export async function runBackupReconciliation(opts: {
  provider: BackupProvider;
  targetId: string;
  vaultId: string;
  keyring: Keyring;
  db: VaultDb;
  storageConnections?: StorageConnectionStore;
  walMarkerTips?: Record<string, number>;
  verifyBucket?: boolean;
  checkedAt: string;
}): Promise<BackupReconciliationState> {
  const verifyBucket = opts.verifyBucket ?? false;
  const [backupResult, casResult, audit] = await Promise.all([
    collectInventory({
      provider: opts.provider,
      targetId: opts.targetId,
      store: 'backup',
      verifyBucket,
    }).then(
      (collection) => ({ collection }),
      (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
    ),
    collectCasInventory({
      db: opts.db,
      ...(opts.storageConnections ? { storageConnections: opts.storageConnections } : {}),
      verifyBucket,
    }),
    collectAudit(opts.provider, opts.targetId),
  ]);

  let cas = unavailableStore(casResult.configured, casResult.error);
  if (casResult.collection) {
    const live = liveBlobShas(opts.db.vault);
    for (const sha of archivedSegmentShas(opts.db.journal)) live.add(sha);
    const index = new ReplicaIndex(opts.db.vault);
    cas = reconcileCasInventory({
      collection: casResult.collection,
      live,
      indexed: index.all(),
      unmark: (sha) => index.unmark(sha),
    });
    if (casResult.authenticatedFailures?.length) {
      cas.missing = {
        count: cas.missing.count + casResult.authenticatedFailures.length,
        sample: [...cas.missing.sample, ...casResult.authenticatedFailures]
          .sort()
          .slice(0, SAMPLE_LIMIT),
      };
    }
  }

  const rows = await opts.provider.listSnapshots(opts.targetId, { includePruned: true });
  let backup = unavailableStore(true, 'backup inventory unavailable');
  let walGaps = drift([]);
  let walCoverage: BackupReconciliationState['walCoverage'] = {
    earliestTickMs: null,
    latestTickMs: null,
    spanDays: null,
    segmentCount: 0,
    markerCount: 0,
  };
  if ('collection' in backupResult && backupResult.collection) {
    const analyzed = await analyzeBackupInventory({
      provider: opts.provider,
      targetId: opts.targetId,
      vaultId: opts.vaultId,
      keyring: opts.keyring,
      rows,
      collection: backupResult.collection,
      ...(opts.walMarkerTips ? { walMarkerTips: opts.walMarkerTips } : {}),
    });
    backup = analyzed.store;
    walGaps = analyzed.walGaps;
    walCoverage = analyzed.walCoverage;
  } else if ('error' in backupResult) {
    backup = unavailableStore(true, backupResult.error);
  }
  const state: BackupReconciliationState = {
    checkedAt: opts.checkedAt,
    mode: verifyBucket ? 'bucket' : 'scheduled',
    status: statusFor(backup, cas, walGaps, audit),
    backup,
    cas,
    walGaps,
    walCoverage,
    snapshots: snapshotInventorySummary(rows),
    audit: {
      source: audit.source,
      eventCount: audit.eventCount,
      recent: audit.recent,
      ...(audit.error ? { error: audit.error } : {}),
    },
  };
  return state;
}
