// Custody-state projection helpers (issue #352 phase 3/4, #367 §C7). Split out
// of custody.ts along the "rebuildable projection" seam so the facade stays
// under the governance line-cap; custody.ts re-exports these, so every caller
// that imports them from `./custody.js` (index.ts, gateway.ts) is untouched.

import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { nowIso } from '../ids.js';
import { shaOfBlobUri } from './store.js';
import type { CustodyState } from './custody-types.js';

/**
 * Persist a custody-state snapshot into `blob_custody_state` (issue #352
 * phase 3/4) — the rebuildable projection apps read as `blob.custody_state`
 * (schema/tables.ts). Only LIVE content items' ORIGINAL bytes are covered —
 * derivatives (thumb/preview) are an implementation detail of serving, not
 * something an app needs custody visibility into. Called from the standing
 * blob sweep (gateway.ts `sweepBlobs`), right after `reconcile()` has already
 * brought both tiers to their steady state, so the snapshot reflects the
 * POST-sweep truth. A full delete+reinsert every run — cheap at personal-vault
 * scale, and it means a purged/trashed content item's stale row can never
 * linger (rebuildable projection, never a durable fact of its own).
 */
export async function refreshCustodyState(db: VaultDb): Promise<{ updated: number }> {
  const rows = db.vault
    .prepare(
      `SELECT content_id, content_uri FROM core_content_item
        WHERE content_uri LIKE 'blob:%' AND deleted_at IS NULL`,
    )
    .all() as { content_id: string; content_uri: string }[];
  const byContent = new Map<string, string>();
  const shas = new Set<string>();
  for (const row of rows) {
    const sha = shaOfBlobUri(row.content_uri);
    if (!sha) continue;
    byContent.set(row.content_id, sha);
    shas.add(sha);
  }
  const status = await db.blobs.statusFor(shas);
  const now = nowIso();
  db.vault.exec('BEGIN');
  try {
    db.vault.prepare('DELETE FROM blob_custody_state').run();
    const insert = db.vault.prepare(
      `INSERT INTO blob_custody_state (content_id, sha256, custody_state, checked_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (const [contentId, sha] of byContent) {
      insert.run(contentId, sha, status.get(sha) ?? 'missing', now);
    }
    db.vault.exec('COMMIT');
  } catch (err) {
    db.vault.exec('ROLLBACK');
    throw err;
  }
  return { updated: byContent.size };
}

/**
 * Cheap per-vault custody breakdown (issue #351 wave 4, #367 prep): counts
 * `blob_custody_state` GROUP BY state — read-only, no tier I/O — so the
 * `blob-sweep` health probe (and #367's later Storage UI card) get
 * replicated-vs-backlog counts without re-listing the remote tier on every
 * poll. Zero-filled for states the mirror currently has no rows in, so
 * callers never need an `?? 0` per key.
 */
export function custodyStateCounts(vault: DatabaseSync): Record<CustodyState, number> {
  const counts: Record<CustodyState, number> = {
    'local-only': 0,
    replicated: 0,
    'remote-only': 0,
    missing: 0,
  };
  const rows = vault
    .prepare(`SELECT custody_state, COUNT(*) AS n FROM blob_custody_state GROUP BY custody_state`)
    .all() as { custody_state: CustodyState; n: number }[];
  for (const row of rows) counts[row.custody_state] = row.n;
  return counts;
}

/**
 * Byte-summed twin of `custodyStateCounts` (issue #367 §C7): the Storage
 * status route wants replicated/backlog progress in BYTES, not just object
 * counts — `core_content_item.byte_size` is already the authoritative size
 * per content id (schema/core.ts), so this is one more GROUP BY join, not a
 * second tier scan. Kept as a separate function rather than widening
 * `custodyStateCounts`'s return shape — the `blob-sweep` health probe (and
 * any other existing caller) only ever wanted counts.
 */
export function custodyStateByteCounts(vault: DatabaseSync): Record<CustodyState, number> {
  const bytes: Record<CustodyState, number> = {
    'local-only': 0,
    replicated: 0,
    'remote-only': 0,
    missing: 0,
  };
  const rows = vault
    .prepare(
      `SELECT s.custody_state AS custody_state, COALESCE(SUM(c.byte_size), 0) AS bytes
         FROM blob_custody_state s
         JOIN core_content_item c ON c.content_id = s.content_id
        GROUP BY s.custody_state`,
    )
    .all() as { custody_state: CustodyState; bytes: number }[];
  for (const row of rows) bytes[row.custody_state] = row.bytes;
  return bytes;
}
