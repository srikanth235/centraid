/*
 * The device-tailable half of a borrowed shape (#726 P5 device route),
 * extracted from `borrowed-store.ts` to keep that file under the repo's
 * file-size guidance (the same split `borrowed-search.ts`/`borrowed-
 * intent.ts` already made).
 *
 * `borrowed_change` (`borrowed-schema.ts`) is a SEPARATE log from the
 * store's own `replica_meta` cursor: that cursor tracks what THIS gateway
 * has pulled from the origin; this one tracks what a MOUNTING DEVICE has
 * not yet seen of it. Multiple upserts to the same row inside one window
 * coalesce to the row's CURRENT state — a device never replays intermediate
 * history it was never promised.
 */

import type { DatabaseSync } from "node:sqlite";

import type { BorrowedEntitySchema } from "./borrowed-store-types.js";

export type BorrowedChangeOp = "upsert" | "delete";

export interface BorrowedChangeEntry {
  entity: string;
  rowId: string;
  op: BorrowedChangeOp;
  values?: Record<string, unknown>;
  oversizedFields?: string[];
  rowVersion?: number;
}

export interface BorrowedChangesPage {
  changes: BorrowedChangeEntry[];
  cursor: number;
}

export function latestBorrowedChangeSeq(
  db: DatabaseSync,
  shapeId: string
): number {
  const row = db
    .prepare(`SELECT MAX(seq) AS seq FROM borrowed_change WHERE shape_id = ?`)
    .get(shapeId) as { seq: number | null };
  return row.seq ?? 0;
}

/** Entity schemas a bootstrap frame's `shape.entities` is built from —
 *  `replica_entity_schema` had no public reader before this (#726 P5). */
export function borrowedEntitySchemas(
  db: DatabaseSync,
  shapeId: string
): BorrowedEntitySchema[] {
  return (
    db
      .prepare(
        `SELECT entity, primary_key, columns_json, has_unavailable_fields
           FROM replica_entity_schema WHERE shape_id = ? ORDER BY entity`
      )
      .all(shapeId) as unknown as Array<{
      entity: string;
      primary_key: string;
      columns_json: string;
      has_unavailable_fields: number;
    }>
  ).map((row) => ({
    entity: row.entity,
    primaryKey: row.primary_key,
    columns: JSON.parse(row.columns_json) as string[],
    ...(row.has_unavailable_fields === 1 ? { hasUnavailableFields: true } : {}),
  }));
}

/**
 * One page of changes since `sinceSeq`, newest state per row. `limit` bounds
 * DISTINCT rows returned, not raw log entries — a row upserted many times in
 * one window still counts once.
 */
export function borrowedChangesSince(
  db: DatabaseSync,
  shapeId: string,
  sinceSeq: number,
  limit: number
): BorrowedChangesPage {
  const latest = db
    .prepare(
      `SELECT entity, row_id, op, MAX(seq) AS seq
         FROM borrowed_change
        WHERE shape_id = ? AND seq > ?
        GROUP BY entity, row_id
        ORDER BY seq
        LIMIT ?`
    )
    .all(shapeId, sinceSeq, limit) as unknown as Array<{
    entity: string;
    row_id: string;
    op: BorrowedChangeOp;
    seq: number;
  }>;
  if (latest.length === 0) return { changes: [], cursor: sinceSeq };
  const rowStmt = db.prepare(
    `SELECT payload_json, oversized_json, server_version
       FROM replica_row WHERE shape_id = ? AND entity = ? AND row_id = ?`
  );
  const changes = latest.flatMap((entry): BorrowedChangeEntry[] => {
    if (entry.entity === "__centraid_intent_outcome") return [];
    if (entry.op === "delete") {
      return [
        {
          entity: entry.entity,
          rowId: entry.row_id,
          op: "delete" as const,
        },
      ];
    }
    const current = rowStmt.get(shapeId, entry.entity, entry.row_id) as
      | { payload_json: string; oversized_json: string; server_version: number }
      | undefined;
    // The row was deleted again after this upsert was logged — report the
    // delete a device would actually observe, never a phantom upsert.
    if (!current) {
      return [
        {
          entity: entry.entity,
          rowId: entry.row_id,
          op: "delete" as const,
        },
      ];
    }
    return [
      {
        entity: entry.entity,
        rowId: entry.row_id,
        op: "upsert" as const,
        values: JSON.parse(current.payload_json) as Record<string, unknown>,
        oversizedFields: JSON.parse(current.oversized_json) as string[],
        ...(current.server_version > 0
          ? { rowVersion: current.server_version }
          : {}),
      },
    ];
  });
  const cursor = Math.max(...latest.map((entry) => entry.seq));
  return { changes, cursor };
}
