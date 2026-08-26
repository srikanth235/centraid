// Custody rollup projection (#711): rebuilt each sweep, never a source of truth.
// SAFETY RULE: `freeable` licenses deletion; it stays STRICTER than
// `BlobCache.runEviction`.

import type { DatabaseSync } from "node:sqlite";

import { readBlobStoreSettings } from "../db.js";
import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import type { CustodyState } from "./custody-types.js";
import { pendingOutboxShas, pinnedThumbShas, stagingShas } from "./evict.js";

/** State buckets count ITEMS, local buckets SHAS; never sum. */
export type CustodyRollupBucket = CustodyState | "freeable" | "local-unproven";

const CUSTODY_STATES: readonly CustodyState[] = [
  "pending-offsite",
  "local-only",
  "replicated",
  "remote-only",
  "missing",
];

const ROLLUP_BUCKETS: readonly CustodyRollupBucket[] = [
  ...CUSTODY_STATES,
  "freeable",
  "local-unproven",
];

export interface CustodyRollupBucketTotals {
  count: number;
  bytes: number;
}

export interface CustodyRollup {
  computedAt: string | null;
  buckets: Record<CustodyRollupBucket, CustodyRollupBucketTotals>;
}

function zeroBuckets(): Record<CustodyRollupBucket, CustodyRollupBucketTotals> {
  const buckets = {} as Record<CustodyRollupBucket, CustodyRollupBucketTotals>;
  for (const bucket of ROLLUP_BUCKETS) buckets[bucket] = { count: 0, bytes: 0 };
  return buckets;
}

interface FreeableGuards {
  /** No remote tier ⇒ nothing freeable. Do NOT reuse `blobCustodyProven`: it
   *  says yes on local presence alone. */
  remoteConfigured: boolean;
  replicatedCas: Set<string>;
  pendingOutbox: Set<string>;
  staging: Set<string>;
  pinned: Set<string>;
}

function readFreeableGuards(vault: DatabaseSync): FreeableGuards {
  const rows = vault
    .prepare("SELECT sha256 FROM blob_replica WHERE store = 'cas'")
    .all() as { sha256: string }[];
  return {
    remoteConfigured: readBlobStoreSettings(vault).kind === "s3",
    replicatedCas: new Set(rows.map((row) => row.sha256)),
    pendingOutbox: pendingOutboxShas(vault),
    staging: stagingShas(vault),
    pinned: pinnedThumbShas(vault),
  };
}

/** Every clause is a VETO. Replica evidence narrows to `cas`: a `derived` row
 *  proves a thumbnail, not the original. */
function freeableSha(sha: string, guards: FreeableGuards): boolean {
  if (!guards.remoteConfigured) return false;
  if (!guards.replicatedCas.has(sha)) return false;
  if (guards.pendingOutbox.has(sha)) return false;
  if (guards.staging.has(sha)) return false;
  if (guards.pinned.has(sha)) return false;
  return true;
}

interface CustodyProjectionRow {
  sha256: string;
  custody_state: CustodyState;
  byte_size: number;
}

/** Call after `refreshCustodyState`: replica evidence must be healed. */
export function refreshCustodyRollup(db: VaultDb): CustodyRollup {
  const rows = db.vault
    .prepare(
      `SELECT s.sha256 AS sha256, s.custody_state AS custody_state, c.byte_size AS byte_size
         FROM blob_custody_state s
         JOIN core_content_item c ON c.content_id = s.content_id`
    )
    .all() as unknown as CustodyProjectionRow[];
  const buckets = zeroBuckets();
  const sizeBySha = new Map<string, number>();
  for (const row of rows) {
    const totals = buckets[row.custody_state];
    totals.count += 1;
    totals.bytes += row.byte_size;
    sizeBySha.set(row.sha256, row.byte_size);
  }

  const guards = readFreeableGuards(db.vault);
  for (const [sha, byteSize] of sizeBySha) {
    if (!db.blobs.hasSync(sha)) continue;
    const totals =
      buckets[freeableSha(sha, guards) ? "freeable" : "local-unproven"];
    totals.count += 1;
    totals.bytes += byteSize;
  }

  const computedAt = nowIso();
  db.vault.exec("BEGIN");
  try {
    db.vault.exec("DELETE FROM blob_custody_rollup");
    const insert = db.vault.prepare(
      `INSERT INTO blob_custody_rollup (bucket, item_count, byte_size, computed_at)
       VALUES (?, ?, ?, ?)`
    );
    for (const bucket of ROLLUP_BUCKETS) {
      const totals = buckets[bucket];
      insert.run(bucket, totals.count, totals.bytes, computedAt);
    }
    db.vault.exec("COMMIT");
  } catch (error) {
    db.vault.exec("ROLLBACK");
    throw error;
  }
  return { computedAt, buckets };
}

interface RollupRow {
  bucket: CustodyRollupBucket;
  item_count: number;
  byte_size: number;
  computed_at: string;
}

/** Null `computedAt` is "nobody looked yet", not "nothing free". */
export function custodyRollup(vault: DatabaseSync): CustodyRollup {
  const rows = vault
    .prepare(
      `SELECT bucket, item_count, byte_size, computed_at FROM blob_custody_rollup`
    )
    .all() as unknown as RollupRow[];
  const buckets = zeroBuckets();
  let computedAt: string | null = null;
  for (const row of rows) {
    if (!(row.bucket in buckets)) continue;
    buckets[row.bucket] = { count: row.item_count, bytes: row.byte_size };
    computedAt = row.computed_at;
  }
  return { computedAt, buckets };
}
