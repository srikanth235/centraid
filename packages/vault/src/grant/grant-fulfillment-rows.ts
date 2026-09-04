import type { DatabaseSync } from "node:sqlite";

import { FULFILLMENT_COLUMNS, toFulfillment } from "./grant-records.js";
import type {
  ShareFulfillmentRecord,
  ShareFulfillmentRow,
  ShareFulfillmentState,
} from "./grant-records.js";
import { prepared } from "./prepared.js";

export type {
  ShareFulfillmentRecord,
  ShareFulfillmentState,
} from "./grant-records.js";

/**
 * `delivered_at` is maintained HERE, never by callers (#846): `delivered`
 * stamps the FIRST instant, `removed` clears it, everything else leaves it be.
 */
export function setFulfillmentState(
  db: DatabaseSync,
  input: {
    grantId: string;
    peerVaultId: string;
    state: ShareFulfillmentState;
    updatedAt: string;
    detail?: string | null;
  }
): ShareFulfillmentRecord {
  const detail = input.detail === undefined ? null : input.detail;
  const clearDelivered = input.state === "removed";
  const deliveredAt = input.state === "delivered" ? input.updatedAt : null;
  db.prepare(
    `INSERT INTO share_fulfillment
       (grant_id, peer_vault_id, state, updated_at, detail, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (grant_id, peer_vault_id) DO UPDATE SET
       state = excluded.state,
       updated_at = excluded.updated_at,
       detail = excluded.detail,
       delivered_at = CASE
         WHEN ${clearDelivered ? 1 : 0} = 1 THEN NULL
         ELSE COALESCE(share_fulfillment.delivered_at, excluded.delivered_at)
       END`
  ).run(
    input.grantId,
    input.peerVaultId,
    input.state,
    input.updatedAt,
    detail,
    deliveredAt
  );
  const row = readFulfillment(db, input.grantId, input.peerVaultId);
  if (!row) {
    throw new Error(
      `share fulfillment ${input.grantId}/${input.peerVaultId} vanished after write`
    );
  }
  return row;
}

export function readFulfillment(
  db: DatabaseSync,
  grantId: string,
  peerVaultId: string
): ShareFulfillmentRecord | undefined {
  const row = prepared(
    db,
    `SELECT ${FULFILLMENT_COLUMNS}
         FROM share_fulfillment WHERE grant_id = ? AND peer_vault_id = ?`
  ).get(grantId, peerVaultId) as ShareFulfillmentRow | undefined;
  return row ? toFulfillment(row) : undefined;
}

export function listFulfillment(
  db: DatabaseSync,
  grantId: string
): ShareFulfillmentRecord[] {
  return (
    prepared(
      db,
      `SELECT ${FULFILLMENT_COLUMNS}
           FROM share_fulfillment WHERE grant_id = ? ORDER BY peer_vault_id`
    ).all(grantId) as ShareFulfillmentRow[]
  ).map(toFulfillment);
}

export interface PendingShareDelivery {
  grantId: string;
  peerVaultId: string;
  state: ShareFulfillmentState;
  /** True when the grant has been revoked, so the pending work is a removal. */
  revoked: boolean;
}

/**
 * Delivery work the peer route still owes, across every grant (#929). The
 * loopback route settles in the pass that starts a subscription; a peer-routed
 * audience cannot, because a network call has no business on a commit path —
 * so the pass leaves `syncing`/`remove_sent` and a sweep drains it.
 *
 * BOUNDED: the sweep asks for a page, so a vault with a thousand stalled peers
 * costs one page per pass rather than one walk of the whole table.
 */
export function listPendingShareDeliveries(
  db: DatabaseSync,
  limit = 100
): PendingShareDelivery[] {
  return (
    prepared(
      db,
      `SELECT f.grant_id, f.peer_vault_id, f.state,
              (a.revoked_at IS NOT NULL) AS revoked
         FROM share_fulfillment f
         JOIN share_authority a ON a.authority_id = f.grant_id
        WHERE f.state IN ('syncing', 'remove_sent')
          AND a.principal_kind IN ('person', 'circle')
        ORDER BY f.updated_at, f.grant_id, f.peer_vault_id
        LIMIT ?`
    ).all(limit) as {
      grant_id: string;
      peer_vault_id: string;
      state: ShareFulfillmentState;
      revoked: number;
    }[]
  ).map((row) => ({
    grantId: row.grant_id,
    peerVaultId: row.peer_vault_id,
    state: row.state,
    revoked: row.revoked === 1,
  }));
}
