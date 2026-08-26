/*
 * How much memory ONE mounted vault may occupy (#659). Separate from `db.ts`
 * because two callers must never disagree: `openVaultDb` applies it at open,
 * the host's registry re-applies it when the mounted set changes.
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * A TOTAL, never a per-FILE constant (#659). `mmapBytes` is address space the
 * OS reclaims; `cacheBytes` is real allocation, the one that matters.
 */
export interface VaultFootprintBudget {
  mmapBytes: number;
  cacheBytes: number;
}

const VAULT_DB_FILES = 2;

/** Chosen so an unset `footprint` reproduces the per-file pragmas exactly. */
export const DEFAULT_VAULT_FOOTPRINT: VaultFootprintBudget = Object.freeze({
  mmapBytes: VAULT_DB_FILES * 64 * 1024 * 1024,
  // 16,000 KiB per file — the literal `-16000` this replaced, not 16 MiB.
  cacheBytes: VAULT_DB_FILES * 16_000 * 1024,
});

/** Overshooting by a few hundred KiB beats a cache SQLite thrashes on. */
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
    mmapBytes: Math.floor(mmapBytes / VAULT_DB_FILES),
    cacheKib: Math.floor(
      Math.max(cacheBytes / VAULT_DB_FILES, MIN_VAULT_FILE_CACHE_BYTES) / 1024
    ),
  };
}

export interface AppliedVaultFootprint {
  mmapBytes: number;
  cacheBytes: number;
}

/**
 * THE one owner of division policy (#659). Callers pass the per-VAULT total
 * once per handle; the return is the per-FILE share applied. Dividing at open
 * alone leaves the sum linear in vault count, so a host re-divides across
 * every open plane when the set changes — that is what keeps the total flat.
 */
export function applyVaultFootprint(
  db: DatabaseSync,
  budget: Partial<VaultFootprintBudget> = {}
): AppliedVaultFootprint {
  const perFile = fileFootprintOf(budget);
  // A negative cache size is kibibytes; mmap is bytes of address space.
  db.exec(`PRAGMA cache_size = -${perFile.cacheKib}`);
  db.exec(`PRAGMA mmap_size = ${perFile.mmapBytes}`);
  return {
    mmapBytes: perFile.mmapBytes,
    cacheBytes: perFile.cacheKib * 1024,
  };
}

/** Hoisted out of `openFile` so a bad budget leaves no half-made directory. */
export function assertVaultFootprint(
  budget: Partial<VaultFootprintBudget> | undefined
): void {
  fileFootprintOf(budget);
}
