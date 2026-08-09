/*
 * Who a replica shape is FOR (#726 P4). `consent_access_grant` selects a
 * grantee two ways — `app_id` or `grantee_party_id` — and this module is the
 * only place that difference is visible. Everything downstream
 * (`evaluateConsent`, row filters, field masks, `projectReplicaPage`) works on
 * whichever comes back, because none of it ever knew which axis it was on.
 */

import type { DatabaseSync } from "node:sqlite";

export interface ReplicaGrantee {
  app_id: string;
  app_name: string;
  signing_key: string | null;
  purpose: string;
}

export interface LentGranteeAccess {
  /** `core_party.party_id` minted for the peer vault by the link. */
  partyId: string;
  /**
   * Row-key material for this edge, standing where an app's `signing_key`
   * stands. A party row carries no secret of its own, so the edge mints one
   * and keeps it OUTSIDE the vault (gateway.db `lent_edges`) — opaque row ids
   * must not be reconstructable by anyone holding only the vault.
   */
  keySecret: string;
}

/**
 * The vault-as-grantee half: the SAME grant/scope
 * join, selecting on `grantee_party_id` where the app half selects on
 * `app_id`. The synthetic `app_name` is `lent:<partyId>` rather than the
 * party's display name — a shape id must not move when a person is renamed.
 */
export function readLentGrantee(
  db: DatabaseSync,
  now: string,
  grantee: LentGranteeAccess
): ReplicaGrantee[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT c.notation AS purpose
           FROM consent_access_grant g
           JOIN core_party p ON p.party_id = g.grantee_party_id
           JOIN core_concept c ON c.concept_id = g.purpose_concept_id
           JOIN consent_grant_scope s ON s.grant_id = g.grant_id
          WHERE g.grantee_party_id = ?
            AND g.status = 'active' AND g.revoked_at IS NULL
            AND (g.expires_at IS NULL OR g.expires_at > ?)
            AND s.verbs IN ('read', 'read+act')
          ORDER BY c.notation`
      )
      .all(grantee.partyId, now) as unknown as Array<{ purpose: string }>
  ).map((row) => ({
    app_id: grantee.partyId,
    app_name: `lent:${grantee.partyId}`,
    signing_key: grantee.keySecret,
    purpose: row.purpose,
  }));
}

export function readGrantees(
  db: DatabaseSync,
  now: string,
  appId?: string
): ReplicaGrantee[] {
  const restriction = appId ? ` AND (a.name = ? OR a.app_id = ?)` : "";
  return db
    .prepare(
      `SELECT DISTINCT a.app_id, a.name AS app_name, a.signing_key,
              c.notation AS purpose
         FROM consent_app a
         JOIN consent_access_grant g ON g.app_id = a.app_id
         JOIN core_concept c ON c.concept_id = g.purpose_concept_id
         JOIN consent_grant_scope s ON s.grant_id = g.grant_id
        WHERE a.status = 'active'
          AND g.status = 'active' AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > ?)
          AND s.verbs IN ('read', 'read+act')${restriction}
        ORDER BY a.name, c.notation`
    )
    .all(now, ...(appId ? [appId, appId] : [])) as unknown as ReplicaGrantee[];
}
