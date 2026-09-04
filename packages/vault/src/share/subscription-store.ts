/*
 * The subscription seat's STORE (#929): one row per (shape, audience vault) on
 * both seats, and the shape-keyed lineage that says which rows a shape placed.
 * Behaviour — ingest, re-projection, purge — lives in `subscription-seat.ts`.
 */

import type { DatabaseSync } from "node:sqlite";

export interface SubscriptionCursor {
  epoch: string | null;
  seq: number;
}

export interface SubscriptionRecord {
  shapeId: string;
  audienceVaultId: string;
  grantId: string;
  originVaultId: string;
  subjectType: string;
  cursor: SubscriptionCursor;
  /** What the seat last ingested; `null` until it holds the shape. */
  structureDigest: string | null;
  state: "subscribed" | "removed";
  detail: string | null;
}

interface SubscriptionRow {
  shape_id: string;
  audience_vault_id: string;
  grant_id: string;
  origin_vault_id: string;
  subject_type: string;
  cursor_epoch: string | null;
  cursor_seq: number;
  structure_digest: string | null;
  state: string;
  detail: string | null;
}

const SUBSCRIPTION_COLUMNS = `shape_id, audience_vault_id, grant_id,
        origin_vault_id, subject_type, cursor_epoch, cursor_seq,
        structure_digest, state, detail`;

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    shapeId: row.shape_id,
    audienceVaultId: row.audience_vault_id,
    grantId: row.grant_id,
    originVaultId: row.origin_vault_id,
    subjectType: row.subject_type,
    cursor: { epoch: row.cursor_epoch, seq: row.cursor_seq },
    structureDigest: row.structure_digest,
    state: row.state === "removed" ? "removed" : "subscribed",
    detail: row.detail,
  };
}

export function readSubscription(
  db: DatabaseSync,
  shapeId: string,
  audienceVaultId: string
): SubscriptionRecord | undefined {
  const row = db
    .prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM share_subscription
        WHERE shape_id = ? AND audience_vault_id = ?`
    )
    .get(shapeId, audienceVaultId) as SubscriptionRow | undefined;
  return row ? toRecord(row) : undefined;
}

export function listSubscriptions(
  db: DatabaseSync,
  filter: { grantId?: string; state?: "subscribed" | "removed" } = {}
): SubscriptionRecord[] {
  const clauses: string[] = [];
  const values: string[] = [];
  if (filter.grantId !== undefined) {
    clauses.push("grant_id = ?");
    values.push(filter.grantId);
  }
  if (filter.state !== undefined) {
    clauses.push("state = ?");
    values.push(filter.state);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return (
    db
      .prepare(
        `SELECT ${SUBSCRIPTION_COLUMNS} FROM share_subscription${where}
          ORDER BY shape_id, audience_vault_id`
      )
      .all(...values) as unknown as SubscriptionRow[]
  ).map(toRecord);
}

export interface RecordSubscriptionInput {
  shapeId: string;
  audienceVaultId: string;
  grantId: string;
  originVaultId: string;
  subjectType: string;
  cursor?: { epoch: string; seq: number };
  structureDigest?: string | null;
  state: "subscribed" | "removed";
  now: string;
  detail?: string | null;
}

/**
 * Upsert on both seats. Within an epoch the cursor only moves forward; a NEW
 * epoch resets it, which is the seat saying it must re-bootstrap — the same
 * answer a device gets, and the reason no floor is extended for a subscriber.
 */
export function recordSubscription(
  db: DatabaseSync,
  input: RecordSubscriptionInput
): void {
  const standing = readSubscription(db, input.shapeId, input.audienceVaultId);
  const seq =
    input.cursor === undefined
      ? (standing?.cursor.seq ?? 0)
      : standing?.cursor.epoch === input.cursor.epoch
        ? Math.max(standing.cursor.seq, input.cursor.seq)
        : input.cursor.seq;
  db.prepare(
    `INSERT INTO share_subscription
       (shape_id, audience_vault_id, grant_id, origin_vault_id, subject_type,
        cursor_epoch, cursor_seq, structure_digest, state, subscribed_at,
        removed_at, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (shape_id, audience_vault_id) DO UPDATE SET
       cursor_epoch = excluded.cursor_epoch,
       cursor_seq = excluded.cursor_seq,
       structure_digest = excluded.structure_digest,
       state = excluded.state,
       removed_at = excluded.removed_at,
       detail = excluded.detail`
  ).run(
    input.shapeId,
    input.audienceVaultId,
    input.grantId,
    input.originVaultId,
    input.subjectType,
    input.cursor?.epoch ?? standing?.cursor.epoch ?? null,
    seq,
    input.structureDigest === undefined
      ? (standing?.structureDigest ?? null)
      : input.structureDigest,
    input.state,
    input.now,
    input.state === "removed" ? input.now : null,
    input.detail ?? null
  );
}

export interface SubscriptionLineageRow {
  shapeId: string;
  targetType: string;
  targetId: string;
  originItemId: string;
  originRowVersion: number;
}

export function readSubscriptionLineage(
  db: DatabaseSync,
  shapeId: string
): SubscriptionLineageRow[] {
  return (
    db
      .prepare(
        `SELECT shape_id, target_type, target_id, origin_item_id,
                origin_row_version
           FROM share_subscription_lineage WHERE shape_id = ?
          ORDER BY target_type, target_id`
      )
      .all(shapeId) as {
      shape_id: string;
      target_type: string;
      target_id: string;
      origin_item_id: string;
      origin_row_version: number;
    }[]
  ).map((row) => ({
    shapeId: row.shape_id,
    targetType: row.target_type,
    targetId: row.target_id,
    originItemId: row.origin_item_id,
    originRowVersion: row.origin_row_version,
  }));
}
