/*
 * Where borrowed bytes live (#726 P4 D4) — and, more to the point, where they
 * do NOT.
 *
 * A lent edge puts another person's rows on this machine. Those rows must
 * never enter `vault.db`, the journal, a backup, or a hosted copy. That is
 * enforced BY LOCATION, not by a filter every future writer has to remember:
 * the borrowed slot is a sibling of `vaultDir` under the gateway data root,
 * so nothing that walks a vault directory can reach it, and nothing that
 * copies a vault directory can carry it.
 *
 *   <dataDir>/borrowed/<slug>.db        one SQLite file per COUNTERPARTY VAULT
 *   <dataDir>/borrowed/<slug>.cas/      that vault's borrowed CAS
 *
 * An edge is a SHAPE inside the store, not a file of its own: two edges from
 * the same person share one file and one CAS, which is what makes "forget
 * this person" a directory the sweep can drop whole.
 */

import crypto from "node:crypto";
import path from "node:path";

export const BORROWED_DIR_NAME = "borrowed";

/** The one directory backup placement and vault walks must never include. */
export function borrowedRoot(dataDir: string): string {
  return path.join(dataDir, BORROWED_DIR_NAME);
}

/**
 * A filesystem-safe, collision-free name for a peer vault id. Vault ids are
 * gateway-minted and already tame, but they arrive here off a link row that a
 * peer supplied, so the slug is derived rather than trusted: a bounded safe
 * prefix for a human reading `ls`, plus a digest that carries the identity.
 */
function slugFor(peerVaultId: string): string {
  const safe = peerVaultId.replaceAll(/[^A-Za-z0-9_-]/gu, "_").slice(0, 48);
  const digest = crypto
    .createHash("sha256")
    .update(peerVaultId)
    .digest("hex")
    .slice(0, 16);
  return `${safe}-${digest}`;
}

export function borrowedStoreFile(
  dataDir: string,
  peerVaultId: string
): string {
  return path.join(borrowedRoot(dataDir), `${slugFor(peerVaultId)}.db`);
}

export function borrowedCasRoot(dataDir: string, peerVaultId: string): string {
  return path.join(borrowedRoot(dataDir), `${slugFor(peerVaultId)}.cas`);
}
