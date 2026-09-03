/*
 * Who a replica shape is FOR (#726). `access_grant` selects a
 * grantee two ways — `app_id` or `grantee_party_id` — and this module is the
 * only place that difference is visible. Everything downstream
 * (`evaluateAccess`, row filters, field masks, `projectReplicaPage`) works on
 * whichever comes back, because none of it ever knew which axis it was on.
 */

import type { DatabaseSync } from "node:sqlite";

export interface ReplicaGrantee {
  app_id: string;
  app_name: string;
  signing_key: string | null;
  purpose: string;
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
         FROM access_app a
         JOIN access_grant g ON g.app_id = a.app_id
         JOIN core_concept c ON c.concept_id = g.purpose_concept_id
         JOIN access_grant_scope s ON s.grant_id = g.grant_id
        WHERE a.status = 'active'
          AND g.status = 'active' AND g.revoked_at IS NULL
          AND (g.expires_at IS NULL OR g.expires_at > ?)
          AND s.verbs IN ('read', 'read+act')${restriction}
        ORDER BY a.name, c.notation`
    )
    .all(now, ...(appId ? [appId, appId] : [])) as unknown as ReplicaGrantee[];
}
