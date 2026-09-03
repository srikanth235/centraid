const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"] as const;
const REPLICA_DATABASE_PREFIX = "centraid-replica-";

export interface PendingUploadAccounting {
  plaintextSize: number;
  targetVaultId?: string;
}

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
  unassigned: PendingUploadBucket;
  total: PendingUploadBucket;
  videoCount: number;
}

export interface StorageDirectoryEntry {
  name: string;
  size: number;
}

export interface OtherPhoneStorage {
  uploadLedgerBytes: number;
  unmountedVaultBytes: number;
  unmountedVaultCount: number;
}

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

function mainDatabaseName(name: string): string {
  const sidecar = SQLITE_SIDECARS.find((suffix) => name.endsWith(suffix));
  return sidecar ? name.slice(0, -sidecar.length) : name;
}
