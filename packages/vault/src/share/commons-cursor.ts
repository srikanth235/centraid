// A commons cursor is a logical offset within one grant/member stream. It
// sits above the vault replica's one ordinary physical change cursor; it is
// not another replication engine or another vault-wide cursor.

import type { DatabaseSync } from "node:sqlite";

export interface CommonsCursor {
  grantId: string;
  memberVaultId: string;
  sequence: number;
  updatedAt: string;
}

export function readCommonsCursor(
  db: DatabaseSync,
  grantId: string,
  memberVaultId: string
): CommonsCursor | undefined {
  const row = db
    .prepare(
      `SELECT grant_id, member_vault_id, sequence, updated_at
         FROM share_commons_cursor
        WHERE grant_id = ? AND member_vault_id = ?`
    )
    .get(grantId, memberVaultId) as
    | {
        grant_id: string;
        member_vault_id: string;
        sequence: number;
        updated_at: string;
      }
    | undefined;
  return row
    ? {
        grantId: row.grant_id,
        memberVaultId: row.member_vault_id,
        sequence: row.sequence,
        updatedAt: row.updated_at,
      }
    : undefined;
}

/** Monotonic advance: delayed or replayed tails cannot move a seat backward. */
export function advanceCommonsCursor(input: {
  db: DatabaseSync;
  grantId: string;
  memberVaultId: string;
  sequence: number;
  now: string;
}): CommonsCursor {
  input.db
    .prepare(
      `INSERT INTO share_commons_cursor
         (grant_id, member_vault_id, sequence, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(grant_id, member_vault_id) DO UPDATE SET
         sequence = MAX(sequence, excluded.sequence),
         updated_at = CASE
           WHEN excluded.sequence >= sequence THEN excluded.updated_at
           ELSE updated_at
         END`
    )
    .run(input.grantId, input.memberVaultId, input.sequence, input.now);
  return readCommonsCursor(input.db, input.grantId, input.memberVaultId)!;
}
