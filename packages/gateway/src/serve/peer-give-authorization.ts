/*
 * A peer may pull bytes for `sha256` from a local vault's CAS only once this
 * gateway has actually GIVEN that peer something out of it — otherwise a
 * linked-but-never-given peer could fish the CAS by guessing hashes learned
 * elsewhere. `share_edges` already records every give this gateway made, so
 * this is a read over the same rows the edge plane itself writes, not a new
 * ledger.
 */

import type { GatewayDatabase } from "./gateway-db.js";

/** Has this gateway ever offered `audienceVaultId` anything from `originVaultId`? */
export function hasGivenEdge(
  db: GatewayDatabase,
  originVaultId: string,
  audienceVaultId: string
): boolean {
  return (
    db.db
      .prepare(
        `SELECT 1 FROM share_edges
          WHERE origin_vault_id = ? AND audience_vault_id = ?
            AND status NOT IN ('denied', 'revoked')
          LIMIT 1`
      )
      .get(originVaultId, audienceVaultId) !== undefined
  );
}
