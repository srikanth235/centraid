import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";

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
