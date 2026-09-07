/*
 * The subscription seat's STORE (#929): one row per (grant, audience vault) on
 * both seats, and the grant-keyed lineage that says which rows a grant placed.
 * Behaviour — ingest, re-projection, purge — lives in `subscription-seat.ts`.
 *
 * KEYED BY `authority_id` (#996, R10): the grant IS the shape, so there is no
 * second id to mint, store and parse back.
 */

import type { DatabaseSync } from "node:sqlite";

export interface SubscriptionCursor {
  epoch: string | null;
  seq: number;
}

export interface SubscriptionRecord {
  authorityId: string;
  audienceVaultId: string;
  originVaultId: string;
  subjectType: string;
  cursor: SubscriptionCursor;
  /** What the seat last ingested; `null` until it holds the grant's rows. */
  structureDigest: string | null;
  state: "subscribed" | "removed";
  detail: string | null;
}

interface SubscriptionRow {
  authority_id: string;
  audience_vault_id: string;
  origin_vault_id: string;
  subject_type: string;
  cursor_epoch: string | null;
  cursor_seq: number;
  structure_digest: string | null;
  state: string;
  detail: string | null;
}

const SUBSCRIPTION_COLUMNS = `authority_id, audience_vault_id,
        origin_vault_id, subject_type, cursor_epoch, cursor_seq,
        structure_digest, state, detail`;

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    authorityId: row.authority_id,
    audienceVaultId: row.audience_vault_id,
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
  authorityId: string,
  audienceVaultId: string
): SubscriptionRecord | undefined {
  const row = db
    .prepare(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM share_subscription
        WHERE authority_id = ? AND audience_vault_id = ?`
    )
    .get(authorityId, audienceVaultId) as SubscriptionRow | undefined;
  return row ? toRecord(row) : undefined;
}

export interface RecordSubscriptionInput {
  authorityId: string;
  audienceVaultId: string;
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
  const standing = readSubscription(
    db,
    input.authorityId,
    input.audienceVaultId
  );
  const seq =
    input.cursor === undefined
      ? (standing?.cursor.seq ?? 0)
      : standing?.cursor.epoch === input.cursor.epoch
        ? Math.max(standing.cursor.seq, input.cursor.seq)
        : input.cursor.seq;
  db.prepare(
    `INSERT INTO share_subscription
       (authority_id, audience_vault_id, origin_vault_id, subject_type,
        cursor_epoch, cursor_seq, structure_digest, state, subscribed_at,
        removed_at, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (authority_id, audience_vault_id) DO UPDATE SET
       cursor_epoch = excluded.cursor_epoch,
       cursor_seq = excluded.cursor_seq,
       structure_digest = excluded.structure_digest,
       state = excluded.state,
       removed_at = excluded.removed_at,
       detail = excluded.detail`
  ).run(
    input.authorityId,
    input.audienceVaultId,
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
  authorityId: string;
  targetType: string;
  targetId: string;
  originItemId: string;
  originRowVersion: number;
}

export function readSubscriptionLineage(
  db: DatabaseSync,
  authorityId: string
): SubscriptionLineageRow[] {
  return (
    db
      .prepare(
        `SELECT authority_id, target_type, target_id, origin_item_id,
                origin_row_version
           FROM share_subscription_lineage WHERE authority_id = ?
          ORDER BY target_type, target_id`
      )
      .all(authorityId) as {
      authority_id: string;
      target_type: string;
      target_id: string;
      origin_item_id: string;
      origin_row_version: number;
    }[]
  ).map((row) => ({
    authorityId: row.authority_id,
    targetType: row.target_type,
    targetId: row.target_id,
    originItemId: row.origin_item_id,
    originRowVersion: row.origin_row_version,
  }));
}
