// Eviction categorization (#405): PINNED, MEDIUM (evict first), staging/
// pending-offsite (never). Pure SQL; `cache.ts` keeps policy.

import type { DatabaseSync } from "node:sqlite";

import { BINARY_DERIVATIVE_SQL } from "./derivatives.js";

/** Browse rung (#405 §3/#414): PINNED — tinies back the browse grid. */
export function pinnedThumbShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM core_content_derivative
        WHERE variant IN (${BINARY_DERIVATIVE_SQL}) AND variant != 'preview' AND sha256 IS NOT NULL`
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}

/** MEDIUM rung (#405): shed first; previews re-read cheaply from remote. */
export function previewShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM core_content_derivative WHERE variant = 'preview' AND sha256 IS NOT NULL`
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}

/**
 * NEVER cache-evictable — owned by the TTL sweep; a draft's review pause must
 * not race a disk-pressure delete.
 */
export function stagingShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM blob_staging
        WHERE variant IS NULL OR variant IN (${BINARY_DERIVATIVE_SQL})`
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}

/** Eviction guard until the transfer runner clears it post-verify. */
export function pendingOutboxShas(vault: DatabaseSync): Set<string> {
  const rows = vault.prepare("SELECT sha256 FROM blob_outbox").all() as {
    sha256: string;
  }[];
  return new Set(rows.map((row) => row.sha256));
}
