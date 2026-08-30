import type { DatabaseSync } from "node:sqlite";

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
