/*
 * The `borrowed_blob` bookkeeping half of the borrowed store, extracted
 * from `borrowed-store.ts` to keep that file under the repo's file-size
 * guidance (the same split `borrowed-search.ts`/`borrowed-intent.ts`/
 * `borrowed-changes.ts` already made). Pure functions over the store's own
 * `DatabaseSync` handle — no state of their own.
 */

import type { DatabaseSync } from "node:sqlite";

import type { BorrowedBlobRef } from "./borrowed-blob-ref.js";

export function recordBorrowedBlob(
  db: DatabaseSync,
  shapeId: string,
  blob: BorrowedBlobRef,
  custody: string
): void {
  db.prepare(
    `INSERT INTO borrowed_blob (shape_id, sha256, rung, byte_size, custody_state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(shape_id, sha256) DO UPDATE SET
       rung = excluded.rung,
       byte_size = excluded.byte_size,
       custody_state = excluded.custody_state,
       updated_at = excluded.updated_at`
  ).run(
    shapeId,
    blob.sha256,
    blob.rung,
    blob.byteSize,
    custody,
    new Date().toISOString()
  );
}

export function borrowedBlobsOfShape(
  db: DatabaseSync,
  shapeId: string
): Array<BorrowedBlobRef & { custodyState: string }> {
  return (
    db
      .prepare(
        `SELECT sha256, rung, byte_size, custody_state FROM borrowed_blob
          WHERE shape_id = ? ORDER BY sha256`
      )
      .all(shapeId) as unknown as Array<{
      sha256: string;
      rung: string;
      byte_size: number;
      custody_state: string;
    }>
  ).map((row) => ({
    sha256: row.sha256,
    rung: row.rung,
    byteSize: row.byte_size,
    custodyState: row.custody_state,
  }));
}

/**
 * Bytes this store actually holds right now, across every shape — the whole
 * point of "per-link" being the same thing as "per store" (#726 P4 item 8):
 * one counterparty vault, one file, one CAS, one budget. Counts only
 * RESIDENT bytes (`custody_state != 'at-origin'`), so a reclaimed or
 * never-pulled ref costs nothing against the budget.
 */
export function borrowedResidentByteTotal(db: DatabaseSync): number {
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(byte_size), 0) AS total FROM borrowed_blob
          WHERE custody_state != 'at-origin'`
      )
      .get() as { total: number }
  ).total;
}

export function setBorrowedBlobCustody(
  db: DatabaseSync,
  sha256: string,
  custody: string
): void {
  db.prepare(
    `UPDATE borrowed_blob SET custody_state = ?, updated_at = ?
      WHERE sha256 = ?`
  ).run(custody, new Date().toISOString(), sha256);
}

export function borrowedBlobCustodyOf(
  db: DatabaseSync,
  sha256: string
): string | undefined {
  return (
    db
      .prepare(
        "SELECT custody_state FROM borrowed_blob WHERE sha256 = ? LIMIT 1"
      )
      .get(sha256) as { custody_state: string } | undefined
  )?.custody_state;
}

/** Shas this shape holds that NO other shape still refers to. */
export function borrowedExclusiveBlobs(
  db: DatabaseSync,
  shapeId: string
): string[] {
  return (
    db
      .prepare(
        `SELECT sha256 FROM borrowed_blob WHERE shape_id = ?
          AND sha256 NOT IN (SELECT sha256 FROM borrowed_blob WHERE shape_id != ?)`
      )
      .all(shapeId, shapeId) as unknown as Array<{ sha256: string }>
  ).map((row) => row.sha256);
}
