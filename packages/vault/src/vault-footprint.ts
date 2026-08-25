/*
 * How much memory ONE mounted vault may occupy, and how that budget is
 * divided (#659).
 *
 * This lives beside `db.ts` rather than inside it because the division is a
 * PUBLIC concept with two callers that must never disagree: `openVaultDb`
 * applies it when a vault is opened, and the host's registry re-applies it to
 * every live plane whenever the set of mounted vaults changes. One module,
 * one policy — a host re-deriving "budget / files, floored at the minimum
 * cache" for itself would silently drift from the opener the day the split
 * changes.
 */

import type { DatabaseSync } from "node:sqlite";

/**
 * The memory one mounted vault may occupy, as a TOTAL across the database
 * files `openVaultDb` opens (#659).
 *
 * The numbers were tuned for one vault on a Pi-class host (#456) and then
 * became per-FILE constants: each mounted plane opens `vault.db` and
 * `journal.db`, so a host mounting N vaults multiplied them by 2N with no way
 * to say otherwise. A total is the useful contract for that host — mounting
 * five planes under one ceiling is `footprint: { mmapBytes: total / 5 }`,
 * arithmetic the host can actually do, rather than a constant it can only
 * accept.
 *
 * `mmapBytes` is address space, not resident memory: SQLite demand-pages it
 * and the OS reclaims under pressure, so it is the cheaper of the two to hand
 * out. `cacheBytes` is real per-connection allocation and is the one that
 * matters when planes multiply.
 */
export interface VaultFootprintBudget {
  /** Total mmap window across the vault's databases, in bytes. */
  mmapBytes: number;
  /** Total page cache across the vault's databases, in bytes. */
  cacheBytes: number;
}

/** Database files `openVaultDb` opens per vault (`vault.db` + `journal.db`). */
const VAULT_DB_FILES = 2;

/**
 * The default TOTAL, chosen so an unset `footprint` reproduces the pre-#659
 * per-file pragmas byte for byte: 2 × 64 MiB mmap and 2 × 16 MiB cache.
 */
export const DEFAULT_VAULT_FOOTPRINT: VaultFootprintBudget = Object.freeze({
  mmapBytes: VAULT_DB_FILES * 64 * 1024 * 1024,
  // 16,000 KiB per file — the literal `-16000` this replaced, not 16 MiB.
  cacheBytes: VAULT_DB_FILES * 16_000 * 1024,
});

/**
 * Floor for the per-file page cache. A host dividing a small budget across
 * many planes can arrive at a number so low that SQLite thrashes on every
 * join; a plane that is pathologically slow is worse for the owner than one
 * that overshoots a budget by a few hundred kibibytes.
 */
export const MIN_VAULT_FILE_CACHE_BYTES = 512 * 1024;

interface FileFootprint {
  mmapBytes: number;
  cacheKib: number;
}

/** Split a per-vault total across the files this vault opens. */
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

/** What one database file was actually given, after splitting and clamping. */
export interface AppliedVaultFootprint {
  mmapBytes: number;
  cacheBytes: number;
}

/**
 * Apply a per-vault footprint budget to ONE open database connection —
 * the same split `openVaultDb` performs, factored out so it can be
 * re-applied to a live handle (#659).
 *
 * Dividing at open time is not enough, because a household grows one vault at
 * a time: vault 1 opens holding the whole budget, vault 2 a half, and the sum
 * is still linear in vault count, just with a smaller constant. Both pragmas
 * are settable on a live connection, so a host re-divides across every open
 * plane whenever the set changes (mount, create, delete) — that is what makes
 * the total flat rather than merely slower-growing.
 *
 * This function exists so that division policy has exactly ONE owner. A host
 * re-deriving "budget ÷ files, floored at the minimum cache" itself would
 * silently disagree with `openVaultDb` the day the split changes.
 *
 * Callers pass the per-VAULT total (the same shape `openVaultDb` takes) and
 * call this once per database handle of that vault; the returned numbers are
 * the per-FILE share that was actually applied.
 */
export function applyVaultFootprint(
  db: DatabaseSync,
  budget: Partial<VaultFootprintBudget> = {}
): AppliedVaultFootprint {
  const perFile = fileFootprintOf(budget);
  // The negative cache size is kibibytes; mmap is bytes of address space.
  db.exec(`PRAGMA cache_size = -${perFile.cacheKib}`);
  db.exec(`PRAGMA mmap_size = ${perFile.mmapBytes}`);
  return {
    mmapBytes: perFile.mmapBytes,
    cacheBytes: perFile.cacheKib * 1024,
  };
}

/**
 * Reject a bad budget before any file is created. `openVaultDb` hoists this
 * out of `openFile` so an invalid footprint never leaves a half-made vault
 * directory behind.
 */
export function assertVaultFootprint(
  budget: Partial<VaultFootprintBudget> | undefined
): void {
  fileFootprintOf(budget);
}
