import { apiHeaders, fetchJson } from "../../lib/gateway";

export interface CustodyTotals {
  count: number;
  bytes: number;
}

export type CustodyBucket =
  | "pending-offsite"
  | "local-only"
  | "replicated"
  | "remote-only"
  | "missing"
  | "freeable"
  | "local-unproven";

export interface CustodyStatus {
  computedAt: string | null;
  buckets: Record<CustodyBucket, CustodyTotals>;
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
    return null;
  }
}
