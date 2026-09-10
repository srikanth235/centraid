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

import {
  createSeatBlobPresence,
  SEAT_BLOB_COLUMNS,
  seatBlobRow,
} from "./blob-presence.js";
import type { SeatBlobRow, SeatBlobSqlRow } from "./blob-presence.js";
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
        .all<SeatBlobSqlRow>(
          `SELECT ${SEAT_BLOB_COLUMNS} FROM seat_blob_presence ORDER BY sha`
        )
        .map(seatBlobRow)
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
 *
 * `token` names the sidecar this came out of (#1014, C5) and is stamped INSIDE
 * the same transaction, so "the queue landed" and "the stash may be dropped"
 * become one durable fact rather than two steps with a resurrection window
 * between them.
 */
export function writeSeatCarryOver(
  driver: SeatSqliteDriver,
  carried: SeatCarryOver,
  token?: string
): void {
  createSeatOutbox(driver);
  createSeatBlobPresence(driver);
  driver.exec(SEAT_CARRY_OVER_DDL);
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
        // The record VERBATIM, not rebuilt from the columns: the columns are
        // what the queue sorts and filters on, and re-deriving the record from
        // them would silently drop every field they do not carry.
        record: intent.record,
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
    if (token !== undefined)
      driver.run(
        `INSERT INTO seat_carry_over (token, applied_at) VALUES (?, ?)
         ON CONFLICT (token) DO NOTHING`,
        [token, new Date().toISOString()]
      );
    driver.exec("COMMIT");
  } catch (error) {
    driver.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Content no eviction and no purge may touch: a pending intent needs it.
 *
 * NAMED FOR WHAT IT ACTUALLY HOLDS (#1014, C6). It was `shasPendingIntentsNeed`
 * and it answered `[]` on every seat that ever ran, because the column behind
 * it was bound to a literal `null` by the only write path. The values are the
 * content references the intent's input names (`namedRowIds`), which is what
 * both the phone's byte store and the seat's own sweeps address content by.
 */
export function contentPendingIntentsNeed(
  carried: Pick<SeatCarryOver, "outbox">
): string[] {
  const held = new Set<string>();
  for (const intent of carried.outbox) {
    if (intent.state === "executed" || intent.state === "denied") continue;
    for (const sha of intent.needsBlobs) held.add(sha);
  }
  return [...held];
}

// ---------------------------------------------------------------------------
// THE SIDECAR: WHERE THE QUEUE SITS WHILE THE FILE IS GONE (#1014, C5/T6).
//
// Everything above is correct in order and wrong in DURABILITY. "Read it out
// of the old file, install, write it into the new one" holds the queue in a JS
// heap object across a multi-megabyte download — and `rebootstrap-copy.ts`
// tells the member "your unsent changes stay queued" while it does. A phone
// killed in that window (the OS reclaiming memory during exactly the download
// that provoked it) loses work nobody can get back, and `install()` on native
// is `removeQuietly(destination); moveSync(incoming)` — the old file is gone
// before the new one is named.
//
// SO THE CARRY-OVER IS WRITTEN TO A FILE BESIDE THE SEAT BEFORE THE HANDLE IS
// CLOSED, and removed only after the write-back has COMMITTED into the new
// file. A JSON sidecar rather than a second SQLite file because all three
// hosts can write bytes beside the seat and only two of them can open a
// database that is not in a pool.
//
// AND THE REPLAY IS EXACTLY-ONCE, BY A MARKER IN THE FILE ITSELF. The clear
// is a second, non-atomic step: a crash between the write-back and the clear
// would otherwise resurrect intents the seat has since drained. So the
// write-back stamps `seat_carry_over` with the stash's own token inside its
// transaction, and a later open that finds the token already there clears the
// sidecar instead of replaying it. The token is derived from the stash's
// content, so it needs no randomness — a host without WebCrypto (Hermes) has
// to be able to mint it.

/** Where a carry-over waits out the swap. One per seat file. */
export interface SeatCarryOverSidecar {
  /** The stashed payload, or undefined when there is none. */
  read: () => Promise<string | undefined>;
  /** Durably. Returning means the bytes survive this process dying. */
  write: (payload: string) => Promise<void>;
  clear: () => Promise<void>;
}

/** The stash on the wire between the two files. */
export interface SeatCarryOverStash {
  readonly token: string;
  /** Whose queue this is. A stash never replays into another vault's file. */
  readonly vaultId: string;
  readonly outbox: readonly SeatOutboxRow[];
  readonly blobs: readonly SeatBlobRow[];
  readonly contents: SeatContents;
}

export const SEAT_CARRY_OVER_DDL = `
CREATE TABLE IF NOT EXISTS seat_carry_over (
  token      TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;
`;

/**
 * FNV-1a over the stash's body.
 *
 * Content-derived rather than random because Hermes has no `crypto.randomUUID`
 * and the property wanted is not unguessability — it is "this exact stash".
 * Two stashes that hash alike hold the same rows by construction, and a replay
 * of the same rows is a no-op (`ON CONFLICT DO NOTHING`), so a collision costs
 * nothing. The new file is a fresh copy of the gateway's and carries no marker
 * table, so a token can never be found in a file that has not seen it.
 */
function carryOverToken(body: string): string {
  let hash = 0x81_1c_9d_c5;
  for (let at = 0; at < body.length; at += 1) {
    hash ^= body.charCodeAt(at);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return `${hash.toString(16).padStart(8, "0")}-${body.length.toString(36)}`;
}

/** Nothing to stash: a seat that queued nothing and holds no blobs. */
export function seatCarryOverIsEmpty(carried: SeatCarryOver): boolean {
  return carried.outbox.length === 0 && carried.blobs.length === 0;
}

export function serializeSeatCarryOver(
  carried: SeatCarryOver,
  vaultId: string
): string {
  const body = JSON.stringify({
    vaultId,
    outbox: carried.outbox,
    blobs: carried.blobs,
    contents: carried.contents,
  });
  return JSON.stringify({ token: carryOverToken(body), body });
}

/**
 * Read a stash back, or answer undefined for one this seat must not replay.
 *
 * A stash that will not parse is DISCARDED rather than thrown on: the caller's
 * next move is a bootstrap either way, and refusing to open a seat because a
 * scratch file is corrupt would turn a lost queue into a lost vault.
 */
export function parseSeatCarryOver(
  payload: string,
  vaultId: string
): SeatCarryOverStash | undefined {
  try {
    const outer = JSON.parse(payload) as { token?: string; body?: string };
    if (typeof outer.token !== "string" || typeof outer.body !== "string")
      return undefined;
    const body = JSON.parse(outer.body) as Omit<SeatCarryOverStash, "token">;
    // R-1014-11 read from this end: a queue belongs to ONE vault, and a
    // sidecar left beside a file that now holds a different one is never
    // replayed into it.
    if (body.vaultId !== vaultId) return undefined;
    return { ...body, token: outer.token };
  } catch {
    return undefined;
  }
}

/** Has this file already taken that stash? */
export function seatCarryOverApplied(
  driver: SeatSqliteDriver,
  token: string
): boolean {
  if (!tablePresent(driver, "seat_carry_over")) return false;
  return (
    driver.all<{ present: number }>(
      `SELECT 1 AS present FROM seat_carry_over WHERE token = ?`,
      [token]
    ).length > 0
  );
}
