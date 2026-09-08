// Reading the gateway's custody rollup. The arithmetic over it is
// `custody-durability.ts`, which has no transport in it and no React Native in
// its graph; this file is the fetch and nothing else.

import { apiHeaders, fetchJson } from "../../lib/gateway";
import { foldCustodyStatus } from "./custody-durability";
import type { CustodyStatus, CustodyStatusVault } from "./custody-durability";

export * from "./custody-durability";

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
