// THE CUSTODY ARITHMETIC, WITH NO TRANSPORT IN IT (#996 wave 3).
//
// Split out of `custody-status.ts` because the fold and the two states are
// pure and the read is not: `custody-status.ts` reaches for `lib/gateway`,
// which reaches for React Native, and the outbox verdict that now needs
// `custodyDurability` is tested on the node tier where that graph does not
// load.
//
// Gateway custody rollup, as the phone reads it (#712).
// `blob.custody_rollup` is the only projection that can say what may safely
// be released — both clients read it. Deriving numbers off
// `blob_custody_state` is how one question gets two arithmetics.
// NOTHING HERE INVENTS A NUMBER (same as photos `storage-model.ts`).
// `computedAt: null` is UNCOUNTED: zeroes are not facts; say "not yet
// computed", never render them. Oldest sweep wins.

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
 * TWO STATES, PLUS A CACHE BIT (#996, R7).
 *
 * "Backed up" means the gateway's CAS holds the sha, VERIFIED. Four of the
 * five custody states say exactly that in four different ways — the gateway's
 * own disk has it (`local-only`), the remote tier has it (`remote-only`), both
 * do (`replicated`), or both will and the push is queued (`pending-offsite`) —
 * and a member deciding whether their photograph is safe off this phone cannot
 * act on the difference. `missing` is the one state that says the bytes are in
 * neither tier, and it is the only honest "not backed up".
 *
 * WHAT IS DELIBERATELY NOT HERE. `local-unproven` is not a sixth state: it
 * counts SHAs and the states count ITEMS ("never sum", `custody-rollup.ts`),
 * it is the arithmetic complement of `freeable` over the local set, and
 * rendering it beside the states is the confusion R7 names. `freeable` is the
 * cache bit — how much this vault could RELEASE — which is a different
 * question from whether anything is at risk.
 */
export const BACKED_UP_BUCKETS: readonly CustodyBucket[] = [
  "replicated",
  "remote-only",
  "local-only",
  "pending-offsite",
];

export const NOT_BACKED_UP_BUCKETS: readonly CustodyBucket[] = ["missing"];

export interface CustodyDurability {
  backedUp: CustodyTotals;
  notBackedUp: CustodyTotals;
  /** The cache bit: what this vault could release, not what is at risk. */
  releasable: CustodyTotals;
}

function sumBuckets(
  buckets: Record<CustodyBucket, CustodyTotals>,
  names: readonly CustodyBucket[]
): CustodyTotals {
  return names.reduce(
    (totals, name) => ({
      count: totals.count + buckets[name].count,
      bytes: totals.bytes + buckets[name].bytes,
    }),
    { count: 0, bytes: 0 }
  );
}

/** The two states and the cache bit, from the rollup the gateway swept. */
export function custodyDurability(status: CustodyStatus): CustodyDurability {
  return {
    backedUp: sumBuckets(status.buckets, BACKED_UP_BUCKETS),
    notBackedUp: sumBuckets(status.buckets, NOT_BACKED_UP_BUCKETS),
    releasable: status.buckets.freeable,
  };
}
