// The custody ROLLUP projection (#711 — Photos' Storage surface).
//
// `blob_custody_state` (custody-state.ts) already answers "where are THIS
// content item's bytes?", one row per live content item. What no surface could
// answer is the aggregate question a Storage screen actually asks — how many
// originals sit in each custody state, what bytes they account for, and how
// much of the local tier could be released without becoming the last copy of
// anything. An app cannot compute that itself: it would have to read every
// content item (the whole library, bytes and all — exactly what the Photos
// library query is bounded to avoid), and the decisive fact, whether the byte
// is PRESENT in the local CAS, lives on a filesystem no app plane can see.
//
// So it is computed here, beside the sweep that already knows both tiers, and
// persisted into `blob_custody_rollup` — a rebuildable projection in the exact
// shape of `blob_custody_state` (delete + reinsert wholesale on every sweep,
// never a source of truth, registered as the logical entity
// `blob.custody_rollup` so an app reads it through the ordinary grant door).
//
// THE SAFETY RULE. The `freeable` bucket is the only thing in this repo that
// tells an owner-facing surface "these bytes can be released". It is therefore
// deliberately STRICTER than `BlobCache.runEviction`'s own predicate, never
// looser: a byte counted here satisfies every guard the evictor applies, plus
// two the evictor gets from its calling context rather than from SQL. Under-
// reporting frees less space than was possible; over-reporting offers to
// delete the only copy of a photograph. Only one of those is survivable, so
// every ambiguity resolves toward "not freeable".

import type { DatabaseSync } from "node:sqlite";

import { readBlobStoreSettings } from "../db.js";
import type { VaultDb } from "../db.js";
import { nowIso } from "../ids.js";
import type { CustodyState } from "./custody-types.js";
import { pendingOutboxShas, pinnedThumbShas, stagingShas } from "./evict.js";

/**
 * The buckets the rollup reports: the five custody states, plus the two that
 * describe the LOCAL tier's releasability. The state buckets count content
 * items; the local buckets count distinct shas, because the disk holds one
 * copy of a set of bytes however many rows point at it. The two families
 * partition different things and are never summed together.
 */
export type CustodyRollupBucket =
  | CustodyState
  /** Locally resident originals with proof of a copy elsewhere — releasable. */
  | "freeable"
  /**
   * Locally resident originals with NO such proof. Deliberately not called
   * "sole copy": absence of proof is not proof of absence (an unconfigured
   * tier, a stalled upload and a genuinely unique byte all land here). What IS
   * certain is that no surface may offer to delete them.
   */
  | "local-unproven";

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

/** One bucket's arithmetic. `bytes` is exact: `core_content_item.byte_size`
 *  is NOT NULL (schema/core.ts), so unlike the app-side per-row totals there
 *  is no unsized remainder to disclose here. */
export interface CustodyRollupBucketTotals {
  count: number;
  bytes: number;
}

export interface CustodyRollup {
  /** When the sweep last rebuilt this, or null if it never has. */
  computedAt: string | null;
  buckets: Record<CustodyRollupBucket, CustodyRollupBucketTotals>;
}

function zeroBuckets(): Record<CustodyRollupBucket, CustodyRollupBucketTotals> {
  const buckets = {} as Record<CustodyRollupBucket, CustodyRollupBucketTotals>;
  for (const bucket of ROLLUP_BUCKETS) buckets[bucket] = { count: 0, bytes: 0 };
  return buckets;
}

/**
 * Everything the freeable test needs, read once per rebuild rather than once
 * per sha — a per-sha `SELECT` would be four statements times the library.
 */
interface FreeableGuards {
  /**
   * Whether a remote tier is configured at all. With none, NOTHING is
   * freeable: the local CAS is the only place the bytes exist. This is exactly
   * where `blobCustodyProven` (custody-proven.ts) must NOT be reused — it
   * answers a different question ("are these bytes durable enough to prune the
   * rows that DESCRIBE them?") and answers yes on local presence alone for a
   * local-only vault. Correct there; catastrophic here, where the act being
   * licensed is the deletion of that very local copy.
   */
  remoteConfigured: boolean;
  /** Shas with durable evidence of a `cas`-classed remote object. */
  replicatedCas: Set<string>;
  /** Shas with an outstanding upload obligation — a replacement is in flight. */
  pendingOutbox: Set<string>;
  /** Shas still in staging: pre-commit plumbing the cache never touches. */
  staging: Set<string>;
  /** Pinned browse-rung derivatives, unevictable under any path. */
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

/**
 * Whether a locally resident original may be offered for release: its bytes
 * are provably held somewhere that is not this disk.
 *
 * Every clause is a veto and the function is total — no branch returns true on
 * missing information. Compare `BlobCache.runEviction`'s `evictable`: local
 * presence, replica evidence, not pinned, not staged, not outbox-pending. This
 * adds `remoteConfigured` (an evidence row can outlive the tier that produced
 * it — the owner removes the storage connection and `blob_replica` still holds
 * yesterday's marks) and narrows replica evidence to the `cas` store class,
 * which is where an ORIGINAL's object lives. A `derived`-classed row is
 * evidence about a thumbnail and must never license deleting the full-quality
 * photograph it was made from.
 */
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

/**
 * Rebuild `blob_custody_rollup` from `blob_custody_state` and the tier
 * evidence. Called by the standing blob sweep (gateway.ts `sweepBlobs`)
 * immediately after `refreshCustodyState`, so it reads the same post-reconcile
 * truth: replica evidence has just been healed against a real remote listing,
 * which is the condition `BlobCache` itself requires before it will shed an
 * ORIGINAL rather than a preview.
 */
export function refreshCustodyRollup(db: VaultDb): CustodyRollup {
  const rows = db.vault
    .prepare(
      `SELECT s.sha256 AS sha256, s.custody_state AS custody_state, c.byte_size AS byte_size
         FROM blob_custody_state s
         JOIN core_content_item c ON c.content_id = s.content_id`
    )
    .all() as unknown as CustodyProjectionRow[];
  const buckets = zeroBuckets();
  // Keyed by sha because the DISK is: two rows naming the same bytes cost one
  // copy, and releasing them frees that space once. `core_content_item.sha256`
  // is UNIQUE today so the map is 1:1 in practice — the projection simply does
  // not depend on that staying true.
  const sizeBySha = new Map<string, number>();
  for (const row of rows) {
    const totals = buckets[row.custody_state];
    totals.count += 1;
    totals.bytes += row.byte_size;
    sizeBySha.set(row.sha256, row.byte_size);
  }

  const guards = readFreeableGuards(db.vault);
  for (const [sha, byteSize] of sizeBySha) {
    // Not on this disk ⇒ nothing here to free and nothing here at risk, so
    // neither local bucket counts it.
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

/**
 * Read the persisted rollup. Zero-filled for buckets the table has no row in,
 * so callers never need a per-key `?? 0`; `computedAt` stays null until the
 * sweep has run, which is the difference between "nothing is freeable" and
 * "nobody has looked yet" — a Storage surface must say those differently.
 */
export function custodyRollup(vault: DatabaseSync): CustodyRollup {
  const rows = vault
    .prepare(
      `SELECT bucket, item_count, byte_size, computed_at FROM blob_custody_rollup`
    )
    .all() as unknown as RollupRow[];
  const buckets = zeroBuckets();
  let computedAt: string | null = null;
  for (const row of rows) {
    if (!(row.bucket in buckets)) continue; // a bucket this build doesn't know
    buckets[row.bucket] = { count: row.item_count, bytes: row.byte_size };
    computedAt = row.computed_at;
  }
  return { computedAt, buckets };
}
