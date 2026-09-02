/**
 * @type {import('@centraid/server/engine').QueryHandler}
 */

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

function knownBucket(value: unknown): StorageBucket | null {
  return typeof value === "string" &&
    (KNOWN_BUCKETS as readonly string[]).includes(value)
    ? (value as StorageBucket)
    : null;
}

export default async function storageHandler({ ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  try {
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
      if (typeof row.item_count !== "number") continue;
      if (typeof row.byte_size !== "number") continue;
      buckets[bucket] = { count: row.item_count, bytes: row.byte_size };
      if (typeof row.computed_at === "string") computedAt = row.computed_at;
    }
    const rollup: StorageRollup = { computedAt, buckets };
    return { rollup };
  } catch (error) {
    const empty: StorageRollup = { computedAt: null, buckets: zeroBuckets() };
    const e = error as { code?: string; message?: string };
    if (e.code === "VAULT_ACCESS")
      return {
        rollup: empty,
        vaultDenied: { code: e.code, message: e.message },
      };
    return { rollup: empty, error: String(e.message ?? error) };
  }
}
