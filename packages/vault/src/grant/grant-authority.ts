import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";

/**
 * Mint the standing `view` authority a SAME-OWNER edge placement carries
 * (#916). `shareItemsToVault` refuses a placement no live `share_authority`
 * stands over; for an edge the member's agreement IS the edge, and it was only
 * ever recorded gateway-side where neither the gate nor an audit of the vault
 * could see it. Idempotent, so a replayed edge restates rather than rivals.
 */
export function grantPlacementAuthority(
  db: DatabaseSync,
  input: {
    itemType: string;
    itemIds: readonly string[];
    audiencePartyId: string;
    grantedAt: string;
    verb?: string;
  }
): void {
  const verb = input.verb ?? "view";
  // The granter is this vault's own party — the member whose rows these are.
  // Read here rather than threaded in: `granted_by` is a real foreign key, and
  // a caller passing a party this vault has never heard of would fail it.
  const owner = db
    .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
    .get() as { self_party_id: string | null } | undefined;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, expires_at, decision, granted_at, granted_by)
     VALUES (?, 'person', ?, ?, ?, ?, 'standing', NULL, 'granted', ?, ?)`
  );
  for (const itemId of input.itemIds) {
    insert.run(
      uuidv7(),
      input.audiencePartyId,
      input.itemType,
      itemId,
      verb,
      input.grantedAt,
      owner?.self_party_id ?? null
    );
  }
}
