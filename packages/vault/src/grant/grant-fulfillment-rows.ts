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

export function ensureFulfillment(
  db: DatabaseSync,
  input: {
    grantId: string;
    peerVaultId: string;
    state: ShareFulfillmentState;
    updatedAt: string;
  }
): ShareFulfillmentRecord {
  // A row opened AT `delivered` carries the memory from birth (#846).
  db.prepare(
    `INSERT INTO share_fulfillment
       (grant_id, peer_vault_id, state, updated_at, detail, delivered_at)
     VALUES (?, ?, ?, ?, NULL, ?)
     ON CONFLICT (grant_id, peer_vault_id) DO NOTHING`
  ).run(
    input.grantId,
    input.peerVaultId,
    input.state,
    input.updatedAt,
    input.state === "delivered" ? input.updatedAt : null
  );
  const row = readFulfillment(db, input.grantId, input.peerVaultId);
  if (!row) {
    throw new Error(
      `share fulfillment ${input.grantId}/${input.peerVaultId} vanished after insert`
    );
  }
  return row;
}

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
