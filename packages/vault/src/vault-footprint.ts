import type { DatabaseSync } from "node:sqlite";

export interface VaultFootprintBudget {
  mmapBytes: number;
  cacheBytes: number;
}

export const DEFAULT_VAULT_FOOTPRINT: VaultFootprintBudget = Object.freeze({
  mmapBytes: 64 * 1024 * 1024,
  cacheBytes: 16_000 * 1024,
});

export const MIN_VAULT_FILE_CACHE_BYTES = 512 * 1024;

interface FileFootprint {
  mmapBytes: number;
  cacheKib: number;
}

function fileFootprintOf(
  footprint: Partial<VaultFootprintBudget> | undefined
): FileFootprint {
  const mmapBytes = footprint?.mmapBytes ?? DEFAULT_VAULT_FOOTPRINT.mmapBytes;
  const cacheBytes =
    footprint?.cacheBytes ?? DEFAULT_VAULT_FOOTPRINT.cacheBytes;
  if (mmapBytes < 0 || cacheBytes < 0)
    throw new Error("vault footprint budget must not be negative");
  return {
    mmapBytes: Math.floor(mmapBytes),
    cacheKib: Math.floor(
      Math.max(cacheBytes, MIN_VAULT_FILE_CACHE_BYTES) / 1024
    ),
  };
}

export interface AppliedVaultFootprint {
  mmapBytes: number;
  cacheBytes: number;
}

export function applyVaultFootprint(
  db: DatabaseSync,
  budget: Partial<VaultFootprintBudget> = {}
): AppliedVaultFootprint {
  const perFile = fileFootprintOf(budget);
  db.exec(`PRAGMA cache_size = -${perFile.cacheKib}`);
  db.exec(`PRAGMA mmap_size = ${perFile.mmapBytes}`);
  return {
    mmapBytes: perFile.mmapBytes,
    cacheBytes: perFile.cacheKib * 1024,
  };
}

export function assertVaultFootprint(
  budget: Partial<VaultFootprintBudget> | undefined
): void {
  fileFootprintOf(budget);
}
