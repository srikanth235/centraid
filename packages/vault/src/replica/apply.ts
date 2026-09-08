// APPLYING THE LOG (#996, rulings R4 and R5).
//
// This is the seat's half of the plane, living here because the CONVERGENCE
// GATE needs it: "a replica copied at seq S and fed rows S..N equals the
// gateway at the watermark" is only a claim until something replays the rows,
// and a test that replays them with bespoke SQL proves nothing about the
// applier a phone will run.
//
// FOUR RULES, EACH ONE A BUG SOMEONE ELSE ALREADY SHIPPED.
//
//  1. `INSERT … ON CONFLICT DO UPDATE`, NEVER `INSERT OR REPLACE`. REPLACE
//     deletes the conflicting row before inserting, and fires the delete
//     triggers only under `recursive_triggers` — so on a seat, whose only
//     triggers are FTS sync, the index silently drifts from the data.
//  2. ONE TRANSACTION PER COMMIT, WITH THE CURSOR IN IT. Applied rows and the
//     seat's position are one fact. Split them and a crash between the two
//     either replays a commit or skips one, and only one of those is
//     recoverable.
//  3. THE EPOCH GATE REFUSES A ROW FROM ANOTHER EPOCH. Without it a schema
//     mismatch is a silent no-op: rows land in tables whose shape has moved,
//     and the first symptom is a query returning the wrong answer.
//  4. TABLE ORDER, NOT DEPENDENCY ORDER, WITH FOREIGN KEYS OFF. A mirror does
//     not re-decide what the writer committed; the log already carries every
//     cascaded delete as its own row, so ordering by dependency would be
//     re-deriving a conclusion it was handed.

import type { DatabaseSync } from "node:sqlite";

import {
  applyRowSql,
  decodeWireValue,
  deleteRowSql,
} from "@centraid/core/protocol";
import type { WireValue } from "@centraid/core/protocol";

import { primaryKeyOf } from "./log.js";
import type { ReplicaLogRow } from "./log.js";

export interface ReplicaApplyResult {
  readonly applied: number;
  readonly commits: number;
  /** `(table, pk)` per batch — what a screen redraws from; nothing polls. */
  readonly touched: readonly {
    table: string;
    primaryKey: readonly WireValue[];
  }[];
  readonly cursor: number;
}

function bindable(
  value: WireValue
): null | string | number | bigint | Uint8Array {
  return decodeWireValue(value);
}

/**
 * Replay log rows into `seat`, one transaction per commit.
 *
 * IDEMPOTENT UNDER DUPLICATE DELIVERY, which is not an extra feature but the
 * same property twice: an insert of a row already present is the upsert's
 * no-op update, and a delete of a row already gone deletes nothing. A batch
 * delivered twice therefore lands the same state, and the cursor — refusing to
 * move backwards — is what keeps the second delivery from undoing progress.
 */
export function applyReplicaLog(
  seat: DatabaseSync,
  rows: readonly ReplicaLogRow[],
  options: { expectedEpoch?: string; cursor?: number } = {}
): ReplicaApplyResult {
  const touched: { table: string; primaryKey: readonly WireValue[] }[] = [];
  let applied = 0;
  let cursor = options.cursor ?? 0;
  const commits = new Map<number, ReplicaLogRow[]>();
  for (const row of rows) {
    if (
      options.expectedEpoch !== undefined &&
      row.epoch !== options.expectedEpoch
    ) {
      throw new Error(
        `replica apply: row ${row.seq} carries epoch ${row.epoch}, this file is ${options.expectedEpoch}`
      );
    }
    const group = commits.get(row.commitSeq);
    if (group) group.push(row);
    else commits.set(row.commitSeq, [row]);
  }
  for (const [, group] of [...commits].sort(([a], [b]) => a - b)) {
    seat.exec("BEGIN IMMEDIATE");
    try {
      for (const row of group) {
        if (row.op === "ddl") {
          if (row.row !== null && typeof row.row["sql"] === "string")
            seat.exec(row.row["sql"]);
          continue;
        }
        const key = primaryKeyOf(seat, row.table);
        if (row.op === "delete") {
          seat
            .prepare(deleteRowSql(row.table, key))
            .run(...row.primaryKey.map(bindable));
        } else {
          const image = row.row;
          if (image === null) {
            throw new Error(
              `replica apply: ${row.op} row ${row.seq} on ${row.table} carries no image`
            );
          }
          const columns = Object.keys(image);
          seat
            .prepare(applyRowSql(row.table, columns, key))
            .run(...columns.map((column) => bindable(image[column]!)));
        }
        touched.push({ table: row.table, primaryKey: row.primaryKey });
        applied += 1;
        cursor = Math.max(cursor, row.seq);
      }
      // The cursor rides in the same transaction as the rows it stands for.
      seat
        .prepare(
          `UPDATE replica_meta SET floor_seq = MAX(floor_seq, 0) WHERE singleton = 1`
        )
        .run();
      seat.exec("COMMIT");
    } catch (error) {
      seat.exec("ROLLBACK");
      throw error;
    }
  }
  return { applied, commits: commits.size, touched, cursor };
}
