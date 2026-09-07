// WHAT SURVIVES A RE-BOOTSTRAP (#996, R23, R25).
//
// A re-bootstrap replaces the seat's file with a copy of the gateway's. That
// is correct for every row in it — they came from the gateway and the gateway
// still has them — and CATASTROPHIC for the three things it does not: the
// member's queued intents, the blobs this seat holds, and the pins that say
// which of them to keep.
//
// The gateway has never heard of any of those. A repair that silently
// destroys the work someone did on a plane is the worst bug this system could
// have, and it is one `VACUUM INTO` away at all times.
//
// SO THE COPY HAPPENS BEFORE THE SWAP, NOT AFTER. Read it out of the old file
// while the old file is still the file; install; write it into the new one.
// The order is the whole contract: "after" is a window in which a crash loses
// the queue, and there is no way to get it back — unlike every row in the
// file, which the next log page returns for free.
//
// AND THE ORDER OF THE QUEUE IS PART OF THE QUEUE. `created_order` is carried
// verbatim rather than re-assigned: intents drain in the order they were made
// (R23), and a re-bootstrap that re-numbers them re-orders the member's work.

import { createSeatBlobPresence } from "./blob-presence.js";
import type { SeatBlobRow } from "./blob-presence.js";
import type { SeatSqliteDriver } from "./driver.js";
import {
  addSeatOutboxIntent,
  createSeatOutbox,
  readSeatOutbox,
} from "./outbox.js";
import type { SeatOutboxRow } from "./outbox.js";
import { setSeatContents } from "./state.js";
import type { SeatContents } from "./storage-probe.js";

/** Everything on a seat that the gateway cannot give back. */
export interface SeatCarryOver {
  readonly outbox: readonly SeatOutboxRow[];
  readonly blobs: readonly SeatBlobRow[];
  /** The contents decision this seat already made (OQ-2). */
  readonly contents: SeatContents;
}

function tablePresent(driver: SeatSqliteDriver, name: string): boolean {
  return (
    driver.all<{ present: number }>(
      `SELECT 1 AS present FROM sqlite_schema
        WHERE type = 'table' AND name = ?`,
      [name]
    ).length > 0
  );
}

/**
 * Read the carry-over out of the file about to be replaced.
 *
 * Every table is optional: a seat being re-bootstrapped may be one that never
 * queued an intent, and a first bootstrap has no old file at all. An absent
 * table is an empty list, never an error — the caller's next move is the same
 * either way, and throwing here would turn "nothing to save" into a failed
 * repair.
 */
export function readSeatCarryOver(driver: SeatSqliteDriver): SeatCarryOver {
  const outbox = tablePresent(driver, "seat_outbox")
    ? readSeatOutbox(driver)
    : [];
  const blobs = tablePresent(driver, "seat_blob_presence")
    ? driver
        .all<{
          sha: string;
          kind: "preview" | "original";
          byte_size: number;
          captured_here: number;
          pinned: number;
          last_used_at: string;
          claim_intent_id: string | null;
          purge_seq: number | null;
          purge_ack_intent_id: string | null;
        }>(
          `SELECT sha, kind, byte_size, captured_here, pinned, last_used_at,
                  claim_intent_id, purge_seq, purge_ack_intent_id
             FROM seat_blob_presence ORDER BY sha`
        )
        .map((row) => ({
          sha: row.sha,
          kind: row.kind,
          byteSize: row.byte_size,
          capturedHere: row.captured_here === 1,
          pinned: row.pinned === 1,
          lastUsedAt: row.last_used_at,
          claimIntentId: row.claim_intent_id ?? undefined,
          purgeSeq: row.purge_seq ?? undefined,
          purgeAckIntentId: row.purge_ack_intent_id ?? undefined,
        }))
    : [];
  const contents = tablePresent(driver, "seat_state")
    ? (driver.all<{ contents: SeatContents }>(
        `SELECT contents FROM seat_state WHERE singleton = 1`
      )[0]?.contents ?? "full")
    : "full";
  return { outbox, blobs, contents };
}

/**
 * Write the carry-over into the file that just replaced it.
 *
 * One transaction: a half-restored outbox is a queue that will drain in an
 * order nobody chose, and it is not recoverable from anywhere.
 */
export function writeSeatCarryOver(
  driver: SeatSqliteDriver,
  carried: SeatCarryOver
): void {
  createSeatOutbox(driver);
  createSeatBlobPresence(driver);
  driver.exec("BEGIN IMMEDIATE");
  try {
    for (const intent of carried.outbox) {
      addSeatOutboxIntent(driver, {
        intentId: intent.intentId,
        // VERBATIM. The order of the queue is part of the queue.
        createdOrder: intent.createdOrder,
        appId: intent.appId,
        action: intent.action,
        input: intent.input,
        payloadHash: intent.payloadHash,
        state: intent.state,
        attempts: intent.attempts,
        dependsOn: intent.dependsOn,
        ...(intent.baseVersions === undefined
          ? {}
          : { baseVersions: intent.baseVersions }),
        optimistic: intent.optimistic,
        ...(intent.commitSeq === undefined
          ? {}
          : { commitSeq: intent.commitSeq }),
        ...(intent.waitingOn === undefined
          ? {}
          : { waitingOn: intent.waitingOn }),
        needsBlobs: intent.needsBlobs,
        enqueuedAt: intent.enqueuedAt,
        updatedAt: intent.updatedAt,
      });
    }
    for (const blob of carried.blobs) {
      driver.run(
        `INSERT INTO seat_blob_presence
           (sha, kind, byte_size, captured_here, pinned, last_used_at,
            claim_intent_id, purge_seq, purge_ack_intent_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (sha) DO NOTHING`,
        [
          blob.sha,
          blob.kind,
          blob.byteSize,
          blob.capturedHere ? 1 : 0,
          blob.pinned ? 1 : 0,
          blob.lastUsedAt,
          blob.claimIntentId ?? null,
          blob.purgeSeq ?? null,
          blob.purgeAckIntentId ?? null,
          blob.lastUsedAt,
        ]
      );
    }
    // Only when the new file has already been given its seat row: the
    // bootstrap writes it, and a carry-over into a file that was never
    // bootstrapped has no seat to describe.
    if (tablePresent(driver, "seat_state"))
      setSeatContents(driver, carried.contents);
    driver.exec("COMMIT");
  } catch (error) {
    driver.exec("ROLLBACK");
    throw error;
  }
}

/** Hashes no eviction and no purge may touch: a pending intent needs them. */
export function shasPendingIntentsNeed(
  carried: Pick<SeatCarryOver, "outbox">
): string[] {
  const held = new Set<string>();
  for (const intent of carried.outbox) {
    if (intent.state === "executed" || intent.state === "denied") continue;
    for (const sha of intent.needsBlobs) held.add(sha);
  }
  return [...held];
}
