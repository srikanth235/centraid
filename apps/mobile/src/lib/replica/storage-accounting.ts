// What the Phone storage screen may claim about this device. Pure folds over
// filesystem sizes and the upload queue's SQL aggregate; the reporting
// contract is docs/mobile-offline.md, "Thumbnail packs and budgets".

const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;
const REPLICA_DATABASE_PREFIX = "centraid-replica-";

export interface PendingUploadAccounting {
  plaintextSize: number;
  targetVaultId?: string;
}

/** One `GROUP BY target_vault_id` row from the upload queue. */
export interface PendingUploadGroup {
  targetVaultId?: string;
  bytes: number;
  itemCount: number;
  videoCount: number;
}

export interface PendingUploadBucket {
  bytes: number;
  itemCount: number;
}

export interface PendingUploadTotals {
  byVault: Map<string, PendingUploadBucket>;
  /** Legacy pre-target rows: durable, real, and assigned to no vault. */
  unassigned: PendingUploadBucket;
  total: PendingUploadBucket;
  videoCount: number;
}

/** One file in the durable replica directory. */
export interface StorageDirectoryEntry {
  name: string;
  size: number;
}

export interface OtherPhoneStorage {
  /** The upload queue's own database family — not any vault's replica. */
  uploadLedgerBytes: number;
  /** Replica databases on disk that no currently mounted scope claims. */
  unmountedVaultBytes: number;
  unmountedVaultCount: number;
}

/** Main SQLite file plus every live rollback/WAL sidecar. */
export function sqliteFamilyBytes(
  databaseName: string,
  sizeOf: (path: string) => number
): number {
  return [
    databaseName,
    ...SQLITE_SIDECARS.map((suffix) => `${databaseName}${suffix}`),
  ].reduce((sum, path) => sum + sizeOf(path), 0);
}

export function pendingBytesByVault(
  items: readonly PendingUploadAccounting[]
): { byVault: Map<string, number>; unassigned: number } {
  const byVault = new Map<string, number>();
  let unassigned = 0;
  for (const item of items) {
    if (!item.targetVaultId) {
      unassigned += item.plaintextSize;
      continue;
    }
    byVault.set(
      item.targetVaultId,
      (byVault.get(item.targetVaultId) ?? 0) + item.plaintextSize
    );
  }
  return { byVault, unassigned };
}

/** The same answer as `pendingBytesByVault` over every pending row, without
 *  the rows: a handful of group rows instead of the whole backlog. */
export function foldPendingUploadGroups(
  groups: readonly PendingUploadGroup[]
): PendingUploadTotals {
  const byVault = new Map<string, PendingUploadBucket>();
  const unassigned: PendingUploadBucket = { bytes: 0, itemCount: 0 };
  const total: PendingUploadBucket = { bytes: 0, itemCount: 0 };
  let videoCount = 0;
  for (const group of groups) {
    const bucket = group.targetVaultId
      ? (byVault.get(group.targetVaultId) ?? { bytes: 0, itemCount: 0 })
      : unassigned;
    bucket.bytes += group.bytes;
    bucket.itemCount += group.itemCount;
    if (group.targetVaultId) byVault.set(group.targetVaultId, bucket);
    total.bytes += group.bytes;
    total.itemCount += group.itemCount;
    videoCount += group.videoCount;
  }
  return { byVault, unassigned, total, videoCount };
}

/**
 * Centraid bytes on this phone that no mounted vault card accounts for: the
 * upload queue's own database, and the replica databases of vaults unmounted
 * or revoked whose files are still on disk. Reporting zero for either is the
 * screen under-claiming what Centraid occupies, the one direction it must
 * never err in. The near-empty per-gateway mounted-reader host database shares
 * the replica prefix and lands in the unmounted bucket — this screen has no
 * gateway id to name it with, and over-attributing a few kilobytes beats
 * dropping real files.
 */
export function otherPhoneStorage(
  entries: readonly StorageDirectoryEntry[],
  mountedDatabaseNames: readonly string[],
  uploadDatabaseName: string
): OtherPhoneStorage {
  const mounted = new Set(mountedDatabaseNames.map(baseName));
  const unmounted = new Set<string>();
  let uploadLedgerBytes = 0;
  let unmountedVaultBytes = 0;
  for (const entry of entries) {
    const main = mainDatabaseName(baseName(entry.name));
    if (main === baseName(uploadDatabaseName)) {
      uploadLedgerBytes += entry.size;
      continue;
    }
    if (!main.startsWith(REPLICA_DATABASE_PREFIX) || mounted.has(main))
      continue;
    unmountedVaultBytes += entry.size;
    unmounted.add(main);
  }
  return {
    uploadLedgerBytes,
    unmountedVaultBytes,
    unmountedVaultCount: unmounted.size,
  };
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** `x.sqlite3-wal` is family of `x.sqlite3`, not a database of its own. */
function mainDatabaseName(name: string): string {
  const sidecar = SQLITE_SIDECARS.find((suffix) => name.endsWith(suffix));
  return sidecar ? name.slice(0, -sidecar.length) : name;
}
