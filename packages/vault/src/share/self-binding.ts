// The one rule `share_party_vault_binding` has that SQLite cannot express in a
// CHECK, in a module both halves of the share plane can reach without either
// importing the other.

import type { DatabaseSync } from "node:sqlite";

/**
 * A BINDING IS ABOUT SOMEONE ELSE (#916, R9 / review 6.5). The table says
 * "this person is reachable at that vault"; a row naming THIS vault or its own
 * party makes the member their own peer, so a share to them would be delivered
 * by the transport to the file it came from. The schema refuses it with a
 * trigger; every writer skips it, because the right behaviour at a call site
 * that is mirroring a roster is to leave the member's own row out, not to
 * fail the whole mirror.
 */
export function isSelfBinding(
  db: DatabaseSync,
  partyId: string,
  vaultId: string
): boolean {
  const own = db
    .prepare("SELECT vault_id, self_party_id FROM core_vault LIMIT 1")
    .get() as { vault_id: string; self_party_id: string | null } | undefined;
  if (!own) return false;
  return own.vault_id === vaultId || own.self_party_id === partyId;
}
