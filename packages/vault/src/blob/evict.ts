// Eviction categorization queries (issue #405 §3) — the pure SQL that tells
// the cache coordinator (blob/cache.ts) which local shas are PINNED (never
// evict), which are MEDIUM previews (evict first), and which are still in
// staging (never evict). Split out so cache.ts stays the policy loop and this
// stays the model read.

import type { DatabaseSync } from 'node:sqlite';
import { BINARY_DERIVATIVE_SQL } from './derivatives.js';

/**
 * The browse rung (issue #405 §3/#414): every `thumb` and video `poster`
 * derivative sha is PINNED —
 * unevictable under any cache-pressure path. Tinies are ~20-40 KB each, they
 * back the browse grid, and losing one forces a remote round-trip to paint a
 * tile the user is actively scrolling. Pin them all.
 */
export function pinnedThumbShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM core_content_derivative
        WHERE variant IN (${BINARY_DERIVATIVE_SQL}) AND variant != 'preview' AND sha256 IS NOT NULL`,
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}

/**
 * The MEDIUM rung (issue #405 §3): `preview` derivative shas — the first thing
 * the eviction pass sheds (LRU), because a lightbox preview re-reads cheaply
 * from remote and is not on the critical browse path the way a tiny is.
 */
export function previewShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM core_content_derivative WHERE variant = 'preview' AND sha256 IS NOT NULL`,
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}

/**
 * Bytes still in `blob_staging` (issue #405 §3, "anything in blob_staging not
 * yet promoted"): NEVER evictable by the cache pass. Staged bytes are pre-
 * commit plumbing whose lifecycle belongs to the TTL sweep (blob/staging.ts
 * `sweepBlobStaging`), not the cache — the review pause of a draft import must
 * not race a disk-pressure delete. The cache pass leaves them entirely alone.
 */
export function stagingShas(vault: DatabaseSync): Set<string> {
  const rows = vault
    .prepare(
      `SELECT sha256 FROM blob_staging
        WHERE variant IS NULL OR variant IN (${BINARY_DERIVATIVE_SQL})`,
    )
    .all() as { sha256: string }[];
  return new Set(rows.map((r) => r.sha256));
}
