// Gateway custody rollup, as the phone reads it (#712).
// `blob.custody_rollup` is the only projection that can say what may safely
// be released — both clients read it. Deriving numbers off
// `blob_custody_state` is how one question gets two arithmetics.
// NOTHING HERE INVENTS A NUMBER (same as photos `storage-model.ts`).
// `computedAt: null` is UNCOUNTED: zeroes are not facts; say "not yet
// computed", never render them. Oldest sweep wins.

import { apiHeaders, fetchJson } from "../../lib/gateway";

export interface CustodyTotals {
  count: number;
  bytes: number;
}

/**
 * Restated from `packages/vault/src/blob/custody-rollup.ts`, not imported:
 * `packages/vault` is Node-only and must not resolve in a React Native graph.
 */
export type CustodyBucket =
  | "pending-offsite"
  | "local-only"
  | "replicated"
  | "remote-only"
  | "missing"
  | "freeable"
  | "local-unproven";

export interface CustodyStatus {
  /** Oldest sweep across counted vaults; null when none has run. */
  computedAt: string | null;
  buckets: Record<CustodyBucket, CustodyTotals>;
  /** Mounted but never swept. Named, not summed. */
  uncounted: string[];
}

export const CUSTODY_BUCKETS: readonly CustodyBucket[] = [
  "pending-offsite",
  "local-only",
  "replicated",
  "remote-only",
  "missing",
  "freeable",
  "local-unproven",
];

export interface CustodyStatusVault {
  name?: string;
  custody?: {
    computedAt: string | null;
    buckets: Partial<Record<CustodyBucket, CustodyTotals>>;
  };
}

function zeroBuckets(): Record<CustodyBucket, CustodyTotals> {
  const buckets = {} as Record<CustodyBucket, CustodyTotals>;
  for (const bucket of CUSTODY_BUCKETS)
    buckets[bucket] = { count: 0, bytes: 0 };
  return buckets;
}

export function foldCustodyStatus(
  vaults: readonly CustodyStatusVault[]
): CustodyStatus {
  const buckets = zeroBuckets();
  const uncounted: string[] = [];
  let computedAt: string | null = null;
  for (const vault of vaults) {
    const custody = vault.custody;
    // Gateway too old to carry the block ≡ never swept: both are "not counted".
    if (!custody || custody.computedAt === null) {
      uncounted.push(vault.name ?? "a vault");
      continue;
    }
    if (computedAt === null || custody.computedAt < computedAt)
      computedAt = custody.computedAt;
    for (const bucket of CUSTODY_BUCKETS) {
      const totals = custody.buckets[bucket];
      if (!totals) continue;
      buckets[bucket] = {
        count: buckets[bucket].count + totals.count,
        bytes: buckets[bucket].bytes + totals.bytes,
      };
    }
  }
  return { computedAt, buckets, uncounted };
}

/**
 * `null` on any read failure — "could not be read", never a zeroed fold
 * (same fail-closed as `readTransferQueue`). Gateway-wide, not a replica entity.
 */
export async function readCustodyStatus(
  gatewayBase: string
): Promise<CustodyStatus | null> {
  try {
    const body = await fetchJson<{ vaults?: CustodyStatusVault[] }>(
      `${gatewayBase}/centraid/_gateway/storage/status`,
      { headers: apiHeaders(), method: "GET" }
    );
    return foldCustodyStatus(body.vaults ?? []);
  } catch {
    // Recovery is the null: "could not be read", never a fold of zeroes.
    return null;
  }
}
