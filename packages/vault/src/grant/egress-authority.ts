// EGRESS ANSWERS IN THE ONE PLANE (#928 A6). A standing "always allow" for an
// external write — minted from a concrete outbox item rather than configured
// up front (#306 decision 3) — is a `share_authority` row like every other
// standing answer, so the Access dashboard, the purge cascade and the receipt
// chain see one id space instead of a side table.
//
// The PRINCIPAL is whoever acts: an automation is an `automation` principal,
// and the owner's own surfaces run on the device credential, so they are
// `device`. The SUBJECT is the egress itself — `subject_type = 'egress'`, the
// wire-level destination as its id, the semantic verb (`gmail.send`) as the
// verb: a capability plus an egress class, the pair the enrichment gate
// decides on. Storage, not the gate.

import type { DatabaseSync } from "node:sqlite";

import { uuidv7 } from "../ids.js";

export const EGRESS_SUBJECT_TYPE = "egress";

export type EgressPrincipalKind = "automation" | "device";

/**
 * `outbox_item.actor_kind` is `identity.provAgentKind`, whose three values are
 * `owner`, `app` and `ai_agent`. Only the last is an automation; the other two
 * reach the outbox on the acting owner's device credential.
 */
export function egressPrincipalKind(actorKind: string): EgressPrincipalKind {
  return actorKind === "ai_agent" ? "automation" : "device";
}

export interface EgressAuthorityKey {
  actorId: string;
  actorKind: string;
  /** Semantic verb, one half of the standing key. */
  verb: string;
  /** Semantic destination, the other half. */
  target: string;
}

export interface EgressAuthorityRecord {
  authorityId: string;
  principalKind: EgressPrincipalKind;
  actorId: string;
  verb: string;
  target: string;
  grantedAt: string;
  revokedAt: string | null;
}

interface EgressRow {
  authority_id: string;
  principal_kind: string;
  principal_id: string;
  verb: string;
  subject_id: string;
  granted_at: string;
  revoked_at: string | null;
}

const EGRESS_SELECT = `SELECT authority_id, principal_kind, principal_id, verb,
    subject_id, granted_at, revoked_at
  FROM share_authority
  WHERE subject_type = '${EGRESS_SUBJECT_TYPE}' AND decision = 'granted'`;

function toRecord(row: EgressRow): EgressAuthorityRecord {
  return {
    authorityId: row.authority_id,
    principalKind: row.principal_kind as EgressPrincipalKind,
    actorId: row.principal_id,
    verb: row.verb,
    target: row.subject_id,
    grantedAt: row.granted_at,
    revokedAt: row.revoked_at,
  };
}

/** The live answer for one `(actor, verb, target)`, or undefined. */
export function liveEgressAuthorityId(
  db: DatabaseSync,
  key: EgressAuthorityKey
): string | undefined {
  const row = db
    .prepare(
      `${EGRESS_SELECT} AND revoked_at IS NULL
         AND principal_kind = ? AND principal_id = ? AND verb = ?
         AND subject_id = ?`
    )
    .get(
      egressPrincipalKind(key.actorKind),
      key.actorId,
      key.verb,
      key.target
    ) as { authority_id: string } | undefined;
  return row?.authority_id;
}

/**
 * Mint the standing answer. An authority row is immutable except `revoked_at`,
 * so re-answering after a revoke inserts; an answer that is already live is
 * returned as it stands. `granted_by` is the member who approved the item the
 * rule was minted from — an `automation` row without one would be an
 * automation that granted itself (#928 A3).
 */
export function recordEgressAuthority(
  db: DatabaseSync,
  input: EgressAuthorityKey & {
    grantedBy: string;
    now: string;
    authorityId?: string;
  }
): string {
  const standing = liveEgressAuthorityId(db, input);
  if (standing) return standing;
  const authorityId = input.authorityId ?? uuidv7();
  db.prepare(
    `INSERT INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, expires_at, decision, granted_at, granted_by,
        revoked_at, receipt_id)
     VALUES (?, ?, ?, '${EGRESS_SUBJECT_TYPE}', ?, ?, 'standing', NULL,
             'granted', ?, ?, NULL, NULL)`
  ).run(
    authorityId,
    egressPrincipalKind(input.actorKind),
    input.actorId,
    input.target,
    input.verb,
    input.now,
    input.grantedBy
  );
  return authorityId;
}

export function listEgressAuthorities(
  db: DatabaseSync
): EgressAuthorityRecord[] {
  return (
    db
      .prepare(
        `${EGRESS_SELECT} ORDER BY revoked_at IS NOT NULL, granted_at DESC`
      )
      .all() as unknown as EgressRow[]
  ).map(toRecord);
}

/** Live answers held by one actor — what an uninstall withdraws (#306). */
export function liveEgressAuthorityIdsFor(
  db: DatabaseSync,
  actorId: string
): string[] {
  return (
    db
      .prepare(
        `${EGRESS_SELECT} AND revoked_at IS NULL AND principal_id = ?
          ORDER BY authority_id`
      )
      .all(actorId) as unknown as { authority_id: string }[]
  ).map((row) => row.authority_id);
}

export function isLiveEgressAuthority(
  db: DatabaseSync,
  authorityId: string
): boolean {
  return (
    db
      .prepare(`${EGRESS_SELECT} AND revoked_at IS NULL AND authority_id = ?`)
      .get(authorityId) !== undefined
  );
}

export function revokeEgressAuthority(
  db: DatabaseSync,
  authorityId: string,
  now: string
): void {
  db.prepare(
    `UPDATE share_authority SET revoked_at = ?
      WHERE authority_id = ? AND subject_type = '${EGRESS_SUBJECT_TYPE}'
        AND revoked_at IS NULL`
  ).run(now, authorityId);
}

/** Every live egress answer at once — the quarantine sweep's one act. */
export function revokeAllEgressAuthorities(
  db: DatabaseSync,
  now: string
): number {
  const result = db
    .prepare(
      `UPDATE share_authority SET revoked_at = ?
        WHERE subject_type = '${EGRESS_SUBJECT_TYPE}' AND revoked_at IS NULL`
    )
    .run(now);
  return Number(result.changes ?? 0);
}
