export interface PendingUploadAccounting {
  plaintextSize: number;
  targetVaultId?: string;
}

/** Main SQLite file plus every live rollback/WAL sidecar. */
export function sqliteFamilyBytes(
  databaseName: string,
  sizeOf: (path: string) => number
): number {
  return [
    databaseName,
    `${databaseName}-wal`,
    `${databaseName}-shm`,
    `${databaseName}-journal`,
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
