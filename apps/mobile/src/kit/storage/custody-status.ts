// THE GATEWAY'S CUSTODY ROLLUP, AS THE PHONE READS IT (#712).
//
// `blob.custody_rollup` is the only projection in this repo that can say what
// may safely be released, so it is the one BOTH clients read:
// `GET /centraid/_gateway/storage/status` carries the rollup itself, and this
// module is where the phone folds it. A client deriving its own two numbers
// off `blob_custody_state` is how one question gets two arithmetics.
//
// NOTHING HERE INVENTS A NUMBER — the rule `packages/blueprints/apps/photos/
// storage-model.ts` states for web, restated for the phone because a member
// looking at a phone deserves the same guarantee. In particular:
//
//   * a vault whose `computedAt` is null is UNCOUNTED. Its zeroes are not
//     facts about the library, so none of them are summed. `computedAt: null`
//     on the folded answer means NOT ONE mounted vault has been swept, and the
//     surface must say "not yet computed" rather than render zeroes.
//   * the oldest sweep instant wins, because a total is only as current as its
//     stalest part.
//
// The fold is pure and separately asserted (`custody-status.test.ts`); the
// fetch is the thin shell around it.

import { apiHeaders, fetchJson } from "../../lib/gateway";

export interface CustodyTotals {
  count: number;
  bytes: number;
}

/**
 * The buckets the vault projection writes
 * (`packages/vault/src/blob/custody-rollup.ts`). Restated here rather than
 * imported: `packages/vault` is Node-only and has no business resolving in a
 * React Native module graph, even for types.
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
  /** The OLDEST sweep instant across counted vaults; null when none has run. */
  computedAt: string | null;
  buckets: Record<CustodyBucket, CustodyTotals>;
  /** Vault names the gateway has mounted but never swept. Named, not summed. */
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

/** One vault's block, exactly as `storage/status` sends it. */
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

/** Fold every mounted vault's rollup into one set of facts. */
export function foldCustodyStatus(
  vaults: readonly CustodyStatusVault[]
): CustodyStatus {
  const buckets = zeroBuckets();
  const uncounted: string[] = [];
  let computedAt: string | null = null;
  for (const vault of vaults) {
    const custody = vault.custody;
    // A gateway too old to carry the block at all is indistinguishable from a
    // vault that has never been swept, and both are honestly "not counted".
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
 * Read the rollup off the gateway. `null` when the read failed at all — the
 * caller must say "could not be read", never print a zeroed fold, which is the
 * same fail-closed rule `readTransferQueue` follows for the local ledger.
 *
 * A one-shot gateway HTTP read outside the replica, the pattern
 * `kit/transfer/transfer-queue.ts` already uses: the rollup is a gateway-wide
 * projection, not a per-vault app entity, so there is nothing on the replica
 * plane to subscribe to.
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
    // The RECOVERY is the null: the caller renders "could not be read" rather
    // than a fold of zeroes, which would read as an empty library.
    return null;
  }
}
