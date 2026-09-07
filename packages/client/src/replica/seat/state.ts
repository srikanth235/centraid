// THE SEAT'S OWN BOOKKEEPING (#996, wave 2).
//
// A seat file is the gateway's file: its schema, its tables, its rows, its
// `replica_meta`. That last one already answers "which epoch is this, and
// where was it taken" — the snapshot leaves `floor_seq` behind precisely so
// the seat can tail from it — so this table deliberately does NOT restate any
// of it. What it holds is the handful of facts that are true of THIS SEAT and
// of no other copy of the vault:
//
//   - how far the applier has got (`applied_seq` / `applied_commit_seq`),
//   - what the gateway said its head was the last time the two spoke
//     (`gateway_watermark`), which with the line above is the watermark the
//     shell shows (R8) — and which is why per-read `coverage` is gone: a
//     coverage flag was a property of one READ, and this is a property of the
//     SEAT, which is the thing a member actually wants to know about,
//   - whether a span was deferred and still owed (`deferred_from`),
//   - which additive DDL version the file has been carried to.
//
// ONE ROW, AND IT IS WRITTEN IN THE APPLIER'S OWN TRANSACTION. That is the
// atomicity invariant in one sentence: applied rows and the seat cursor commit
// together, so a crash mid-batch leaves a state the next attempt completes
// rather than a cursor that has run ahead of the rows it names.

import type { SeatSqliteDriver } from "./driver.js";

/**
 * Created on the seat file after the snapshot lands, never shipped by the
 * gateway: the gateway has no `seat_state`, and a table it does not have
 * cannot be captured into the log and applied back over itself.
 *
 * STRICT, like the rest of the plane. `deferred_from` is NULL when nothing is
 * owed — the alternative, 0, is a real seq.
 */
export const SEAT_STATE_DDL = `
CREATE TABLE IF NOT EXISTS seat_state (
  singleton          INTEGER PRIMARY KEY CHECK (singleton = 1),
  vault_id           TEXT NOT NULL,
  epoch              TEXT NOT NULL,
  schema_epoch       INTEGER NOT NULL CHECK (schema_epoch >= 1),
  ddl_version        INTEGER NOT NULL DEFAULT 0 CHECK (ddl_version >= 0),
  -- Where the applier has got to. Both move in one transaction with the rows.
  applied_seq        INTEGER NOT NULL CHECK (applied_seq >= 0),
  applied_commit_seq INTEGER NOT NULL DEFAULT 0 CHECK (applied_commit_seq >= 0),
  -- The gateway's head as of the last page. Never a guess: a seat that has
  -- not spoken to the gateway reports its own cursor as the head, which reads
  -- as "caught up as far as I know" rather than as a fabricated distance.
  gateway_watermark  INTEGER NOT NULL DEFAULT 0 CHECK (gateway_watermark >= 0),
  -- The first seq of the oldest span this seat SKIPPED because its commit
  -- crossed the defer threshold. NULL when nothing is owed.
  deferred_from      INTEGER,
  updated_at         TEXT NOT NULL
) STRICT;
`;

export interface SeatState {
  readonly vaultId: string;
  readonly epoch: string;
  readonly schemaEpoch: number;
  readonly ddlVersion: number;
  readonly appliedSeq: number;
  readonly appliedCommitSeq: number;
  readonly gatewayWatermark: number;
  readonly deferredFrom: number | undefined;
}

interface SeatStateSql {
  vault_id: string;
  epoch: string;
  schema_epoch: number;
  ddl_version: number;
  applied_seq: number;
  applied_commit_seq: number;
  gateway_watermark: number;
  deferred_from: number | null;
}

export class SeatStateMissingError extends Error {
  readonly code = "seat_state_missing";
  constructor() {
    super("seat state is missing; this file was never bootstrapped as a seat");
    this.name = "SeatStateMissingError";
  }
}

const SELECT = `SELECT vault_id, epoch, schema_epoch, ddl_version, applied_seq,
       applied_commit_seq, gateway_watermark, deferred_from
  FROM seat_state WHERE singleton = 1`;

export function readSeatState(driver: SeatSqliteDriver): SeatState {
  const row = driver.all<SeatStateSql>(SELECT)[0];
  if (!row) throw new SeatStateMissingError();
  return {
    vaultId: row.vault_id,
    epoch: row.epoch,
    schemaEpoch: row.schema_epoch,
    ddlVersion: row.ddl_version,
    appliedSeq: row.applied_seq,
    appliedCommitSeq: row.applied_commit_seq,
    gatewayWatermark: row.gateway_watermark,
    deferredFrom: row.deferred_from ?? undefined,
  };
}

export function seatStatePresent(driver: SeatSqliteDriver): boolean {
  return (
    driver.all<{ present: number }>(
      `SELECT 1 AS present FROM sqlite_schema
        WHERE type = 'table' AND name = 'seat_state'`
    ).length > 0 && driver.all<{ present: number }>(SELECT).length > 0
  );
}

/**
 * Write the seat's row for a file that has just been bootstrapped.
 *
 * `appliedSeq` is the snapshot's own position — the number the door put in a
 * header beside the bytes — because that is exactly what the file contains.
 */
export function initSeatState(
  driver: SeatSqliteDriver,
  init: {
    vaultId: string;
    epoch: string;
    schemaEpoch: number;
    ddlVersion?: number;
    appliedSeq: number;
    gatewayWatermark?: number;
    now?: string;
  }
): void {
  driver.exec(SEAT_STATE_DDL);
  driver.run(
    `INSERT INTO seat_state (
       singleton, vault_id, epoch, schema_epoch, ddl_version, applied_seq,
       applied_commit_seq, gateway_watermark, deferred_from, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, 0, ?, NULL, ?)
     ON CONFLICT (singleton) DO UPDATE SET
       vault_id = excluded.vault_id,
       epoch = excluded.epoch,
       schema_epoch = excluded.schema_epoch,
       ddl_version = excluded.ddl_version,
       applied_seq = excluded.applied_seq,
       applied_commit_seq = excluded.applied_commit_seq,
       gateway_watermark = excluded.gateway_watermark,
       deferred_from = NULL,
       updated_at = excluded.updated_at`,
    [
      init.vaultId,
      init.epoch,
      init.schemaEpoch,
      init.ddlVersion ?? 0,
      init.appliedSeq,
      init.gatewayWatermark ?? init.appliedSeq,
      init.now ?? new Date().toISOString(),
    ]
  );
}
