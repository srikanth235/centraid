/**
 * The custody rollup for ONE scope (issue #711) — what the Storage screen
 * needs and the library window cannot give it.
 *
 * `queries/library.ts` deliberately reads a bounded recent window, so the
 * totals derived from it describe the photographs that happen to be loaded,
 * not the library. Widening that window to answer "what do my originals cost?"
 * would ship every content item (bytes included) on every refresh — the exact
 * cost that query exists to avoid. So the arithmetic is done once on the
 * gateway, on its standing blob sweep, and persisted as seven small rows:
 * `blob.custody_rollup` (packages/vault/src/blob/custody-rollup.ts).
 *
 * This handler reads those rows and nothing else. It performs no arithmetic of
 * its own beyond shaping — there is no number here this app could invent, and
 * none it does.
 *
 * WHAT IT DOES NOT ANSWER. `computed_at` is when the gateway last looked, not
 * "now". A rollup that has never been computed comes back with `computedAt:
 * null`, which the surface must render as "nobody has looked yet" rather than
 * as a row of honest-looking zeroes.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

/** The buckets the vault projection writes. Kept in step with
 *  `CustodyRollupBucket` (packages/vault/src/blob/custody-rollup.ts): an
 *  unknown bucket from a newer gateway is DROPPED rather than rendered as an
 *  unlabelled row. */
const KNOWN_BUCKETS = [
  "pending-offsite",
  "local-only",
  "replicated",
  "remote-only",
  "missing",
  "freeable",
  "local-unproven",
] as const;

export type StorageBucket = (typeof KNOWN_BUCKETS)[number];

export interface StorageBucketTotals {
  count: number;
  bytes: number;
}

export interface StorageRollup {
  /** ISO instant of the gateway's last sweep, or null if it never ran. */
  computedAt: string | null;
  buckets: Record<StorageBucket, StorageBucketTotals>;
}

interface RawRollupRow {
  bucket?: unknown;
  item_count?: unknown;
  byte_size?: unknown;
  computed_at?: unknown;
}

function zeroBuckets(): Record<StorageBucket, StorageBucketTotals> {
  const buckets = {} as Record<StorageBucket, StorageBucketTotals>;
  for (const bucket of KNOWN_BUCKETS) buckets[bucket] = { count: 0, bytes: 0 };
  return buckets;
}

/** A bucket name this build knows, or null. Narrowing at the boundary, so no
 *  string from the wire reaches the view as a label. */
function knownBucket(value: unknown): StorageBucket | null {
  return typeof value === "string" &&
    (KNOWN_BUCKETS as readonly string[]).includes(value)
    ? (value as StorageBucket)
    : null;
}

export default async function storageHandler({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  try {
    // Seven rows, one per bucket — the whole table, and small by construction.
    const result = await ctx.vault.read({
      entity: "blob.custody_rollup",
      purpose,
    });
    const rows = (result.rows ?? []) as unknown as RawRollupRow[];
    const buckets = zeroBuckets();
    let computedAt: string | null = null;
    for (const row of rows) {
      const bucket = knownBucket(row.bucket);
      if (!bucket) continue;
      // A row whose numbers are not numbers is a broken projection, not a zero.
      // Skipping it keeps the bucket at its zero-fill AND leaves it out of the
      // total, which is the same thing the reader would want said in words.
      if (typeof row.item_count !== "number") continue;
      if (typeof row.byte_size !== "number") continue;
      buckets[bucket] = { count: row.item_count, bytes: row.byte_size };
      if (typeof row.computed_at === "string") computedAt = row.computed_at;
    }
    const rollup: StorageRollup = { computedAt, buckets };
    return { rollup };
  } catch (error) {
    // Same outcome grammar as queries/library.ts: a consent denial is a
    // first-class answer ("ask the owner"), everything else is our failure and
    // must not be dressed up as one.
    const empty: StorageRollup = { computedAt: null, buckets: zeroBuckets() };
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_CONSENT")
      return {
        rollup: empty,
        vaultDenied: { code: e.code, message: e.message },
      };
    return { rollup: empty, error: String(e.message ?? error) };
  }
}
