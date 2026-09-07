// THE OUTBOX AS A TABLE IN THE SEAT'S OWN FILE (#996, R24).
//
// The same `IntentRecordStore` contract the browser's IndexedDB outbox and the
// in-memory one satisfy, over `seat_outbox`. Which sounds like a third
// implementation of the same thing, and is not: this one shares a DATABASE
// with the rows the intents are about, and that single fact is what makes
// R24's central promise expressible at all —
//
//   an executed answer clears its overlay IN THE TRANSACTION THAT CARRIES ITS
//   COMMIT.
//
// A browser outbox in IndexedDB cannot do that; it reconciles across two
// stores and lives with a window. Here the applier's in-transaction hook and
// this table are the same transaction, so acknowledgement-before-delta and
// delta-before-acknowledgement converge with no flicker and no doubled effect.
//
// THE RECORD IS STORED AS JSON BESIDE ITS INDEXED COLUMNS. `state`,
// `created_order`, `commit_seq` and the payload hash are columns because the
// queue orders, filters and clears on them; everything else is the intent's
// own shape, which belongs to the shared core and must not be re-declared —
// and re-columnised — here every time it grows a field.

import { ReplicaProtocolError } from "../errors.js";
import { buildIntentOutcome } from "../intent-record-store.js";
import type {
  IntentRecordStore,
  NewStoredIntent,
} from "../intent-record-store.js";
import type { IntentOutcome, IntentState, ReplicaIntent } from "../types.js";
import type { SeatSqliteDriver } from "./driver.js";
import { createSeatOutbox } from "./outbox.js";

/** Journal cap: `listSettled` cannot read past it. Same bound as its siblings. */
const SETTLED_JOURNAL_LIMIT = 5_000;

const SETTLED_DDL = `
CREATE TABLE IF NOT EXISTS seat_outbox_settled (
  intent_id  TEXT PRIMARY KEY,
  settled_at TEXT NOT NULL,
  outcome_json TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS seat_outbox_settled_at_idx
  ON seat_outbox_settled(settled_at);
`;

interface RecordSql {
  record_json: string;
}

/**
 * A deep copy, through JSON rather than `structuredClone`.
 *
 * The same reason `intent-revision.ts` gives: React Native 0.81/Hermes has no
 * `structuredClone` global, and this store is written to run on the phone.
 * An intent is JSON by construction — it is hashed as canonical JSON — so the
 * round trip loses nothing it could have carried.
 */
function clone<T>(value: T): T {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- Hermes has no `structuredClone`; see the note above
  return JSON.parse(JSON.stringify(value)) as T;
}

export class SeatIntentStore implements IntentRecordStore {
  /**
   * The seat has the cursor (#996, R24): `clearSeatOverlaysAtCommit` runs
   * inside the applier's transaction, so an answer parked on its `commit_seq`
   * settles the instant the rows it was drawn over arrive. No other store can
   * say this, and none of them do.
   */
  readonly settlesByCommitSeq = true;

  private constructor(private readonly driver: SeatSqliteDriver) {}

  /** Create the tables if they are absent and open a store over them. */
  static create(driver: SeatSqliteDriver): SeatIntentStore {
    createSeatOutbox(driver);
    driver.exec(SETTLED_DDL);
    return new SeatIntentStore(driver);
  }

  add(intent: NewStoredIntent): Promise<ReplicaIntent> {
    const existing = this.#read(intent.intentId);
    if (existing) {
      if (existing.payloadHash !== intent.payloadHash) {
        return Promise.reject(
          new ReplicaProtocolError(
            `Intent id ${intent.intentId} was reused with another payload`
          )
        );
      }
      return Promise.resolve(existing);
    }
    const next =
      this.driver.all<{ next: number }>(
        `SELECT COALESCE(MAX(created_order), 0) + 1 AS next FROM seat_outbox`
      )[0]?.next ?? 1;
    const record: ReplicaIntent = { ...clone(intent), createdOrder: next };
    this.#write(record, "insert");
    return Promise.resolve(clone(record));
  }

  get(intentId: string): Promise<ReplicaIntent | undefined> {
    return Promise.resolve(this.#read(intentId));
  }

  list(states?: readonly IntentState[]): Promise<ReplicaIntent[]> {
    const rows = this.driver.all<RecordSql>(
      `SELECT record_json FROM seat_outbox ORDER BY created_order`
    );
    const selected = states ? new Set(states) : undefined;
    return Promise.resolve(
      rows
        .map((row) => JSON.parse(row.record_json) as ReplicaIntent)
        .filter((intent) => !selected || selected.has(intent.state))
    );
  }

  /**
   * The head of the queue, claimed.
   *
   * ONE AT A TIME, IN OUTBOX ORDER (R23): a transport failure holds the head,
   * so the next intent is not sent past the one that failed. The order is
   * `created_order`, which is the order the member made them in.
   */
  claimNext(): Promise<ReplicaIntent | undefined> {
    const row = this.driver.all<RecordSql>(
      `SELECT record_json FROM seat_outbox WHERE state = 'queued'
        ORDER BY created_order LIMIT 1`
    )[0];
    if (!row) return Promise.resolve(undefined);
    const queued = JSON.parse(row.record_json) as ReplicaIntent;
    return this.transition(queued.intentId, ["queued"], {
      state: "sending",
      attempts: queued.attempts + 1,
      reason: undefined,
    });
  }

  transition(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    const existing = this.#require(intentId, allowed, "transition");
    if (existing instanceof Error) return Promise.reject(existing);
    const updated: ReplicaIntent = {
      ...existing,
      ...clone(patch),
      intentId,
      createdOrder: existing.createdOrder,
    };
    this.#write(updated, "update");
    return Promise.resolve(clone(updated));
  }

  /**
   * Settle, which REMOVES the queued input.
   *
   * The durable outcome survives, the sensitive payload does not: a settled
   * intent's input is the member's data sitting in a queue that no longer
   * needs it. The two writes are one transaction — an outcome journalled
   * without the row being removed is a duplicate waiting to be re-sent.
   */
  settle(
    intentId: string,
    allowed: readonly IntentState[],
    patch: Partial<ReplicaIntent>
  ): Promise<ReplicaIntent> {
    const existing = this.#require(intentId, allowed, "settle");
    if (existing instanceof Error) return Promise.reject(existing);
    const settled: ReplicaIntent = {
      ...existing,
      ...clone(patch),
      intentId,
      createdOrder: existing.createdOrder,
    };
    const outcome = buildIntentOutcome(settled);
    this.driver.exec("BEGIN IMMEDIATE");
    try {
      this.driver.run(`DELETE FROM seat_outbox WHERE intent_id = ?`, [
        intentId,
      ]);
      this.driver.run(
        `INSERT INTO seat_outbox_settled (intent_id, settled_at, outcome_json)
         VALUES (?, ?, ?)
         ON CONFLICT (intent_id) DO UPDATE SET
           settled_at = excluded.settled_at,
           outcome_json = excluded.outcome_json`,
        [
          intentId,
          outcome.settledAt ?? new Date().toISOString(),
          JSON.stringify(outcome),
        ]
      );
      this.#pruneJournal();
      this.driver.exec("COMMIT");
    } catch (error) {
      this.driver.exec("ROLLBACK");
      throw error;
    }
    return Promise.resolve(clone(settled));
  }

  listSettled(limit = 500): Promise<IntentOutcome[]> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > SETTLED_JOURNAL_LIMIT
    ) {
      return Promise.reject(
        new ReplicaProtocolError("Settled outcome limit is invalid")
      );
    }
    return Promise.resolve(
      this.driver
        .all<{
          outcome_json: string;
        }>(
          `SELECT outcome_json FROM seat_outbox_settled
            ORDER BY settled_at DESC, intent_id DESC LIMIT ?`,
          [limit]
        )
        .map((row) => JSON.parse(row.outcome_json) as IntentOutcome)
    );
  }

  clear(): Promise<void> {
    this.driver.exec("DELETE FROM seat_outbox");
    this.driver.exec("DELETE FROM seat_outbox_settled");
    return Promise.resolve();
  }

  close(): void {
    // The DRIVER is the seat's, shared with the applier and the reader; the
    // store does not own it and must not close it.
  }

  destroy(): Promise<void> {
    return this.clear();
  }

  #read(intentId: string): ReplicaIntent | undefined {
    const row = this.driver.all<RecordSql>(
      `SELECT record_json FROM seat_outbox WHERE intent_id = ?`,
      [intentId]
    )[0];
    return row ? (JSON.parse(row.record_json) as ReplicaIntent) : undefined;
  }

  #require(
    intentId: string,
    allowed: readonly IntentState[],
    verb: string
  ): ReplicaIntent | Error {
    const existing = this.#read(intentId);
    if (!existing)
      return new ReplicaProtocolError(`Unknown intent ${intentId}`);
    if (!allowed.includes(existing.state)) {
      return new ReplicaProtocolError(
        `Intent ${intentId} cannot ${verb === "settle" ? "settle" : "transition"} from ${existing.state}`
      );
    }
    return existing;
  }

  #write(record: ReplicaIntent, mode: "insert" | "update"): void {
    const json = JSON.stringify(record);
    if (mode === "insert") {
      this.driver.run(
        `INSERT INTO seat_outbox (
           intent_id, created_order, app_id, action, input_json, payload_hash,
           state, attempts, depends_on_json, base_versions_json,
           optimistic_json, commit_seq, waiting_on_json, needs_blobs_json,
           enqueued_at, updated_at, record_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        this.#bind(record, json)
      );
      return;
    }
    this.driver.run(
      `UPDATE seat_outbox SET state = ?, attempts = ?, depends_on_json = ?,
              base_versions_json = ?, optimistic_json = ?, commit_seq = ?,
              waiting_on_json = ?, updated_at = ?, record_json = ?
        WHERE intent_id = ?`,
      [
        record.state,
        record.attempts,
        record.dependsOn && record.dependsOn.length > 0
          ? JSON.stringify(record.dependsOn)
          : null,
        record.baseVersions ? JSON.stringify(record.baseVersions) : null,
        record.optimistic.length > 0 ? JSON.stringify(record.optimistic) : null,
        record.commitSeq ?? null,
        record.waitingOn ? JSON.stringify(record.waitingOn) : null,
        new Date().toISOString(),
        json,
        record.intentId,
      ]
    );
  }

  #bind(record: ReplicaIntent, json: string): (string | number | null)[] {
    const now = new Date().toISOString();
    return [
      record.intentId,
      record.createdOrder,
      record.appId,
      record.action,
      JSON.stringify(record.input ?? null),
      record.payloadHash,
      record.state,
      record.attempts,
      record.dependsOn && record.dependsOn.length > 0
        ? JSON.stringify(record.dependsOn)
        : null,
      record.baseVersions ? JSON.stringify(record.baseVersions) : null,
      record.optimistic.length > 0 ? JSON.stringify(record.optimistic) : null,
      record.commitSeq ?? null,
      record.waitingOn ? JSON.stringify(record.waitingOn) : null,
      null,
      record.enqueuedAt ?? now,
      now,
      json,
    ];
  }

  #pruneJournal(): void {
    this.driver.run(
      `DELETE FROM seat_outbox_settled WHERE intent_id IN (
         SELECT intent_id FROM seat_outbox_settled
          ORDER BY settled_at DESC, intent_id DESC
          LIMIT -1 OFFSET ?)`,
      [SETTLED_JOURNAL_LIMIT]
    );
  }
}

/**
 * Clear every overlay this commit has earned, INSIDE the caller's transaction
 * (#996, R24).
 *
 * The synchronous twin of `IntentQueue.settleAtCommitSeq`, and the reason the
 * applier has an in-transaction hook at all: passed as
 * `onCommitInTransaction`, this runs after the commit's rows and before
 * COMMIT, so the pending row and the canonical rows it was drawn over become
 * visible in the same instant. Every asynchronous alternative has a window,
 * and a crash inside that window leaves an overlay nothing will clear.
 *
 * It opens no transaction of its own — it is already in one, and a nested
 * BEGIN would fail — and it writes the journal entry the async path writes,
 * so a settled intent looks the same however it settled.
 */
export function clearSeatOverlaysAtCommit(
  driver: SeatSqliteDriver,
  commitSeq: number,
  now = new Date().toISOString()
): string[] {
  const rows = driver.all<RecordSql>(
    `SELECT record_json FROM seat_outbox
      WHERE state = 'awaiting-change' AND commit_seq IS NOT NULL
        AND commit_seq <= ?
      ORDER BY created_order`,
    [commitSeq]
  );
  const cleared: string[] = [];
  for (const row of rows) {
    const intent = JSON.parse(row.record_json) as ReplicaIntent;
    const outcome = buildIntentOutcome({ ...intent, state: "executed" });
    driver.run(`DELETE FROM seat_outbox WHERE intent_id = ?`, [
      intent.intentId,
    ]);
    driver.run(
      `INSERT INTO seat_outbox_settled (intent_id, settled_at, outcome_json)
       VALUES (?, ?, ?)
       ON CONFLICT (intent_id) DO UPDATE SET
         settled_at = excluded.settled_at,
         outcome_json = excluded.outcome_json`,
      [intent.intentId, outcome.settledAt ?? now, JSON.stringify(outcome)]
    );
    cleared.push(intent.intentId);
  }
  return cleared;
}

/**
 * The hook to hand `applySeatLogPage`. A batch of commits clears whatever each
 * one has earned, in the transaction that advanced the cursor past it.
 */
export function seatOverlayClearingHook(
  driver: SeatSqliteDriver,
  onCleared?: (intentIds: readonly string[]) => void
): (commitSeq: number) => void {
  return (commitSeq) => {
    const cleared = clearSeatOverlaysAtCommit(driver, commitSeq);
    if (cleared.length > 0) onCleared?.(cleared);
  };
}
