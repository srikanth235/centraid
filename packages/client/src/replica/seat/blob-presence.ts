// WHICH BYTES THIS SEAT ACTUALLY HAS (#996, ruling R7).
//
// `blob_presence(sha, seat_id)` is a CANONICAL fact — seats write it as
// intents and every seat then sees every seat's answer — but a seat cannot
// write a canonical row directly, and the intent it sends has to be derived
// from something local and durable. This is that something: one row per blob
// this seat holds, on the seat's own file, outside the replicated schema.
//
// THE SEAT'S CLAIM IS NEVER THE DURABILITY ANSWER. "Backed up" means the
// GATEWAY's CAS holds the sha, verified — which is a fact about the gateway,
// not about how many phones happen to have a copy. So this table deliberately
// answers only "do I have it, and have I said so", and the owner-facing two
// states (backed up / not) are read elsewhere. Conflating the two is how a
// member deletes the last copy of a photo because three devices said "yes".
//
// AND A PURGE IS A HANDSHAKE, NOT A BROADCAST. When the gateway purges a blob
// it writes a tombstone; a seat that sees one deletes its bytes and
// ACKNOWLEDGES. Without the acknowledgement the gateway cannot tell "every
// seat has dropped it" from "one seat has been offline for a month", and those
// call for opposite answers when the member asks whether the thing is gone.

import type { SeatBlobKind } from "./byte-policy.js";
import type { SeatSqliteDriver } from "./driver.js";

/**
 * The seat's own byte ledger. Not replicated: the gateway has no such table,
 * so a commit can never carry it back over the seat's own answer.
 *
 * `purge_seq` is the log position of the tombstone that condemned the blob,
 * so an acknowledgement names WHICH purge it answers rather than "the latest".
 */
export const SEAT_BLOB_PRESENCE_DDL = `
CREATE TABLE IF NOT EXISTS seat_blob_presence (
  sha            TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('preview', 'original')),
  byte_size      INTEGER NOT NULL CHECK (byte_size >= 0),
  -- This seat produced the bytes; they may exist nowhere else yet.
  captured_here  INTEGER NOT NULL DEFAULT 0 CHECK (captured_here IN (0, 1)),
  -- The member said "keep offline". An LRU may not touch it.
  pinned         INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  last_used_at   TEXT NOT NULL,
  -- The presence intent that told the gateway about this row, once sent.
  claim_intent_id TEXT,
  -- The tombstone this row is answering, and the intent that answered it.
  purge_seq      INTEGER,
  purge_ack_intent_id TEXT,
  updated_at     TEXT NOT NULL
) STRICT;
-- The two working sets: what has not been claimed, and what is condemned and
-- not yet acknowledged. Both are scanned every reconcile.
CREATE INDEX IF NOT EXISTS seat_blob_presence_unclaimed_idx
  ON seat_blob_presence(sha) WHERE claim_intent_id IS NULL;
CREATE INDEX IF NOT EXISTS seat_blob_presence_unacked_idx
  ON seat_blob_presence(purge_seq)
  WHERE purge_seq IS NOT NULL AND purge_ack_intent_id IS NULL;
`;

export interface SeatBlobRow {
  readonly sha: string;
  readonly kind: Exclude<SeatBlobKind, "thumb">;
  readonly byteSize: number;
  readonly capturedHere: boolean;
  readonly pinned: boolean;
  readonly lastUsedAt: string;
  readonly claimIntentId: string | undefined;
  readonly purgeSeq: number | undefined;
  readonly purgeAckIntentId: string | undefined;
}

interface BlobSql {
  sha: string;
  kind: "preview" | "original";
  byte_size: number;
  captured_here: number;
  pinned: number;
  last_used_at: string;
  claim_intent_id: string | null;
  purge_seq: number | null;
  purge_ack_intent_id: string | null;
}

const COLUMNS = `sha, kind, byte_size, captured_here, pinned, last_used_at,
       claim_intent_id, purge_seq, purge_ack_intent_id`;

function shape(row: BlobSql): SeatBlobRow {
  return {
    sha: row.sha,
    kind: row.kind,
    byteSize: row.byte_size,
    capturedHere: row.captured_here === 1,
    pinned: row.pinned === 1,
    lastUsedAt: row.last_used_at,
    claimIntentId: row.claim_intent_id ?? undefined,
    purgeSeq: row.purge_seq ?? undefined,
    purgeAckIntentId: row.purge_ack_intent_id ?? undefined,
  };
}

export function createSeatBlobPresence(driver: SeatSqliteDriver): void {
  driver.exec(SEAT_BLOB_PRESENCE_DDL);
}

export interface RecordSeatBlobOptions {
  readonly sha: string;
  readonly kind: Exclude<SeatBlobKind, "thumb">;
  readonly byteSize: number;
  readonly capturedHere?: boolean;
  readonly pinned?: boolean;
  readonly now?: string;
}

/**
 * This seat now holds these bytes.
 *
 * `ON CONFLICT DO UPDATE` on everything except the claim and the tombstone:
 * re-recording a blob refreshes its recency and may PROMOTE it (a cached blob
 * the member has now pinned), but it must never quietly erase the fact that a
 * purge is outstanding — a re-download of condemned bytes is a bug to see, not
 * a state to overwrite.
 */
export function recordSeatBlob(
  driver: SeatSqliteDriver,
  options: RecordSeatBlobOptions
): void {
  const now = options.now ?? new Date().toISOString();
  driver.run(
    `INSERT INTO seat_blob_presence
       (sha, kind, byte_size, captured_here, pinned, last_used_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (sha) DO UPDATE SET
       byte_size = excluded.byte_size,
       captured_here = max(seat_blob_presence.captured_here, excluded.captured_here),
       pinned = max(seat_blob_presence.pinned, excluded.pinned),
       last_used_at = excluded.last_used_at,
       updated_at = excluded.updated_at`,
    [
      options.sha,
      options.kind,
      options.byteSize,
      options.capturedHere === true ? 1 : 0,
      options.pinned === true ? 1 : 0,
      now,
      now,
    ]
  );
}

export function pinSeatBlob(
  driver: SeatSqliteDriver,
  sha: string,
  pinned: boolean,
  now = new Date().toISOString()
): void {
  driver.run(
    `UPDATE seat_blob_presence SET pinned = ?, updated_at = ? WHERE sha = ?`,
    [pinned ? 1 : 0, now, sha]
  );
}

export function readSeatBlob(
  driver: SeatSqliteDriver,
  sha: string
): SeatBlobRow | undefined {
  const row = driver.all<BlobSql>(
    `SELECT ${COLUMNS} FROM seat_blob_presence WHERE sha = ?`,
    [sha]
  )[0];
  return row ? shape(row) : undefined;
}

/** Blobs this seat holds and has not yet told the gateway about. */
export function unclaimedSeatBlobs(
  driver: SeatSqliteDriver,
  limit = 500
): SeatBlobRow[] {
  return driver
    .all<BlobSql>(
      `SELECT ${COLUMNS} FROM seat_blob_presence
        WHERE claim_intent_id IS NULL AND purge_seq IS NULL
        ORDER BY last_used_at LIMIT ?`,
      [limit]
    )
    .map(shape);
}

export function noteSeatBlobClaimed(
  driver: SeatSqliteDriver,
  sha: string,
  intentId: string,
  now = new Date().toISOString()
): void {
  driver.run(
    `UPDATE seat_blob_presence SET claim_intent_id = ?, updated_at = ?
      WHERE sha = ?`,
    [intentId, now, sha]
  );
}

/**
 * A tombstone reached this seat: the bytes are condemned.
 *
 * The row is KEPT, not deleted. Deleting it would leave nothing to
 * acknowledge from and nothing to re-send if the acknowledgement is lost —
 * and "I have forgotten about this blob" is indistinguishable from "I never
 * had it", which is the one thing the gateway must be able to tell apart.
 *
 * Returns the bytes the caller must now remove from its blob store; the seat's
 * FILES are not this module's to delete.
 */
export function applySeatPurgeTombstone(
  driver: SeatSqliteDriver,
  sha: string,
  purgeSeq: number,
  now = new Date().toISOString()
): SeatBlobRow | undefined {
  const held = readSeatBlob(driver, sha);
  if (!held) return undefined;
  driver.run(
    `UPDATE seat_blob_presence
        SET purge_seq = ?, pinned = 0, updated_at = ?
      WHERE sha = ?`,
    [purgeSeq, now, sha]
  );
  return held;
}

/** Condemned blobs whose acknowledgement this seat still owes the gateway. */
export function unacknowledgedSeatPurges(
  driver: SeatSqliteDriver,
  limit = 500
): SeatBlobRow[] {
  return driver
    .all<BlobSql>(
      `SELECT ${COLUMNS} FROM seat_blob_presence
        WHERE purge_seq IS NOT NULL AND purge_ack_intent_id IS NULL
        ORDER BY purge_seq LIMIT ?`,
      [limit]
    )
    .map(shape);
}

export function noteSeatPurgeAcknowledged(
  driver: SeatSqliteDriver,
  sha: string,
  intentId: string,
  now = new Date().toISOString()
): void {
  driver.run(
    `UPDATE seat_blob_presence
        SET purge_ack_intent_id = ?, updated_at = ?
      WHERE sha = ? AND purge_seq IS NOT NULL`,
    [intentId, now, sha]
  );
}

/**
 * The LRU's candidates, oldest first, up to `bytesWanted`.
 *
 * Pinned rows, captures and anything a pending intent needs are excluded IN
 * SQL rather than filtered afterwards: a candidate list that briefly contains
 * a protected sha is a candidate list someone will eventually act on.
 */
export function seatEvictionCandidates(
  driver: SeatSqliteDriver,
  bytesWanted: number,
  protectedShas: readonly string[] = []
): SeatBlobRow[] {
  const rows = driver
    .all<BlobSql>(
      `SELECT ${COLUMNS} FROM seat_blob_presence
        WHERE pinned = 0 AND captured_here = 0 AND purge_seq IS NULL
        ORDER BY last_used_at`
    )
    .map(shape);
  const guarded = new Set(protectedShas);
  const chosen: SeatBlobRow[] = [];
  let freed = 0;
  for (const row of rows) {
    if (freed >= bytesWanted) break;
    if (guarded.has(row.sha)) continue;
    chosen.push(row);
    freed += row.byteSize;
  }
  return chosen;
}
