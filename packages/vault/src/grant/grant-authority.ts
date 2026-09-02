import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";

export interface RevokedAuthorityRow {
  authorityId: string;
  principalKind: string;
  principalId: string;
  subjectType: string;
  subjectId: string;
  verb: string;
  decision: string;
}

const LIVE_AUTHORITY_COLUMNS = `authority_id, principal_kind, principal_id,
  subject_type, subject_id, verb, decision`;

type LiveAuthorityRow = {
  authority_id: string;
  principal_kind: string;
  principal_id: string;
  subject_type: string;
  subject_id: string;
  verb: string;
  decision: string;
};

function toAuthority(row: LiveAuthorityRow): RevokedAuthorityRow {
  return {
    authorityId: row.authority_id,
    principalKind: row.principal_kind,
    principalId: row.principal_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    verb: row.verb,
    decision: row.decision,
  };
}

/**
 * End every standing answer over a PURGED subject; the caller receipts each.
 * The rows SURVIVE, outside the poly-ref sweep: a decision ends by being
 * revoked, never deleted with the thing it was about (#883).
 */
export function revokeAuthorityOverSubject(
  db: DatabaseSync,
  input: { subjectType: string; subjectId: string; revokedAt: string }
): RevokedAuthorityRow[] {
  const live = (
    db
      .prepare(
        `SELECT ${LIVE_AUTHORITY_COLUMNS} FROM share_authority
          WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL`
      )
      .all(input.subjectType, input.subjectId) as LiveAuthorityRow[]
  ).map(toAuthority);
  if (live.length === 0) return live;
  db.prepare(
    `UPDATE share_authority SET revoked_at = ?
      WHERE subject_type = ? AND subject_id = ? AND revoked_at IS NULL`
  ).run(input.revokedAt, input.subjectType, input.subjectId);
  return live;
}

export function revokeAuthorityForPrincipal(
  db: DatabaseSync,
  input: { principalKind: string; principalId: string; revokedAt: string }
): RevokedAuthorityRow[] {
  const live = (
    db
      .prepare(
        `SELECT ${LIVE_AUTHORITY_COLUMNS} FROM share_authority
          WHERE principal_kind = ? AND principal_id = ? AND revoked_at IS NULL`
      )
      .all(input.principalKind, input.principalId) as LiveAuthorityRow[]
  ).map(toAuthority);
  if (live.length === 0) return live;
  db.prepare(
    `UPDATE share_authority SET revoked_at = ?
      WHERE principal_kind = ? AND principal_id = ? AND revoked_at IS NULL`
  ).run(input.revokedAt, input.principalKind, input.principalId);
  return live;
}

export function listStandingShareAuthority(
  db: DatabaseSync
): RevokedAuthorityRow[] {
  return (
    db
      .prepare(
        `SELECT ${LIVE_AUTHORITY_COLUMNS} FROM share_authority
          WHERE principal_kind IN ('person','circle') AND revoked_at IS NULL
          ORDER BY subject_type, subject_id`
      )
      .all() as LiveAuthorityRow[]
  ).map(toAuthority);
}

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
