// THE OUTBOX, WHERE IT SHARES THE SEAT'S FILE (#996, R23–R25).
//
// A seat's queued work is the one thing on the device that exists NOWHERE
// ELSE. Rows are re-pulled from a cursor and blobs are re-fetched from the
// CAS; an intent the member made on a train is gone if this table is.
//
// WHICH IS WHY IT LIVES IN THE SEAT'S FILE ON THE PHONE AND THE DESKTOP, and
// in IndexedDB in the browser — the choice is not cosmetic. Where the outbox
// shares the file, an executed answer can clear its overlay in the SAME
// transaction that advances the applied cursor (R24), which is what makes
// "acknowledgement before delta" and "delta before acknowledgement" converge
// with no flicker and no doubled effect. Where it does not, the seat pays a
// two-writer reconciliation instead. Both are supported; this is the first.
//
// AND IT IS WHY A RE-BOOTSTRAP CARRIES IT ACROSS. The new file is a copy of
// the gateway, and the gateway has never heard of these rows. See
// `carry-over.ts`: the copy happens BEFORE the swap, or the member's queued
// work is destroyed by a repair.

import type { SeatSqliteDriver } from "./driver.js";

/**
 * `created_order` is an explicit monotonic column rather than a timestamp:
 * intents drain in the order they were MADE (R23), and two intents made in the
 * same millisecond on a phone are common. A device clock never decides
 * canonical order, and it does not decide local order either.
 *
 * `depends_on_json` is the causal chain's edge set (R23), derived by the seat
 * from the row ids its own projections minted. It is stored rather than
 * recomputed so a restart reconstructs the same graph it sent.
 */
export const SEAT_OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS seat_outbox (
  intent_id      TEXT PRIMARY KEY,
  created_order  INTEGER NOT NULL,
  app_id         TEXT NOT NULL,
  action         TEXT NOT NULL,
  input_json     TEXT NOT NULL,
  payload_hash   TEXT NOT NULL,
  -- The seat-side vocabulary, unchanged by #996 (R24 invariant): only the
  -- local projection mechanism changes, never what an intent can settle to.
  -- 'awaiting-change' is 'the gateway committed and this seat has not applied
  -- it yet', which is the state the commit_seq column below exists to end.
  state          TEXT NOT NULL
    CHECK (state IN ('queued', 'sending', 'awaiting-change', 'parked',
                     'executed', 'denied', 'conflict', 'conflict-base-missing',
                     'expired', 'failed')),
  attempts       INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  depends_on_json TEXT,
  base_versions_json TEXT,
  optimistic_json TEXT,
  -- Set when the gateway answers 'executed'. The overlay is held until the
  -- applied cursor reaches it — which is the whole of R24 in one column.
  commit_seq     INTEGER,
  waiting_on_json TEXT,
  -- Content this intent still needs on this device before it may run (R25):
  -- the references its input names, written by the store at add() and kept
  -- current through a revision (#1014, C6). The LRU may not evict them. The
  -- column keeps its shipped name — a seat file in the field carries it.
  needs_blobs_json TEXT,
  enqueued_at    TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- THE RECORD ITSELF. The columns above are the ones the queue ORDERS,
  -- FILTERS and CLEARS on; the intent's own shape belongs to the shared core
  -- (ReplicaIntent) and is stored whole rather than re-declared — and
  -- re-columnised — here every time it grows a field.
  record_json    TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS seat_outbox_order_idx
  ON seat_outbox(created_order);
CREATE INDEX IF NOT EXISTS seat_outbox_awaiting_idx
  ON seat_outbox(commit_seq) WHERE commit_seq IS NOT NULL;
`;

export function createSeatOutbox(driver: SeatSqliteDriver): void {
  driver.exec(SEAT_OUTBOX_DDL);
}

/**
 * The seat's settled vocabulary — the SAME one every intent path has today
 * (#996 invariant: only the local projection mechanism changes). Mirrors
 * `IntentState` in `types.ts`; the CHECK on the table above is the durable
 * copy of it.
 */
export type SeatOutboxState =
  | "queued"
  | "sending"
  | "awaiting-change"
  | "parked"
  | "executed"
  | "denied"
  | "conflict"
  | "conflict-base-missing"
  | "expired"
  | "failed";

export interface SeatOutboxRow {
  readonly intentId: string;
  readonly createdOrder: number;
  readonly appId: string;
  readonly action: string;
  readonly input: Record<string, unknown>;
  readonly payloadHash: string;
  readonly state: SeatOutboxState;
  readonly attempts: number;
  readonly dependsOn: readonly string[];
  readonly baseVersions: Record<string, unknown> | undefined;
  readonly optimistic: readonly unknown[];
  readonly commitSeq: number | undefined;
  readonly waitingOn: Record<string, unknown> | undefined;
  readonly needsBlobs: readonly string[];
  readonly enqueuedAt: string;
  readonly updatedAt: string;
  /** The whole record, verbatim — what a carry-over copies across. */
  readonly record: string;
}

interface OutboxSql {
  intent_id: string;
  created_order: number;
  app_id: string;
  action: string;
  input_json: string;
  payload_hash: string;
  state: SeatOutboxState;
  attempts: number;
  depends_on_json: string | null;
  base_versions_json: string | null;
  optimistic_json: string | null;
  commit_seq: number | null;
  waiting_on_json: string | null;
  needs_blobs_json: string | null;
  enqueued_at: string;
  updated_at: string;
  record_json: string;
}

const COLUMNS = `intent_id, created_order, app_id, action, input_json,
       payload_hash, state, attempts, depends_on_json, base_versions_json,
       optimistic_json, commit_seq, waiting_on_json, needs_blobs_json,
       enqueued_at, updated_at, record_json`;

function parse<T>(json: string | null, fallback: T): T {
  return json === null ? fallback : (JSON.parse(json) as T);
}

export function shapeSeatOutboxRow(row: OutboxSql): SeatOutboxRow {
  return {
    intentId: row.intent_id,
    createdOrder: row.created_order,
    appId: row.app_id,
    action: row.action,
    input: JSON.parse(row.input_json) as Record<string, unknown>,
    payloadHash: row.payload_hash,
    state: row.state,
    attempts: row.attempts,
    dependsOn: parse<string[]>(row.depends_on_json, []),
    baseVersions: parse<Record<string, unknown> | undefined>(
      row.base_versions_json,
      undefined
    ),
    optimistic: parse<unknown[]>(row.optimistic_json, []),
    commitSeq: row.commit_seq ?? undefined,
    waitingOn: parse<Record<string, unknown> | undefined>(
      row.waiting_on_json,
      undefined
    ),
    needsBlobs: parse<string[]>(row.needs_blobs_json, []),
    enqueuedAt: row.enqueued_at,
    updatedAt: row.updated_at,
    record: row.record_json,
  };
}

export function readSeatOutbox(driver: SeatSqliteDriver): SeatOutboxRow[] {
  return driver
    .all<OutboxSql>(`SELECT ${COLUMNS} FROM seat_outbox ORDER BY created_order`)
    .map(shapeSeatOutboxRow);
}

export interface AddSeatOutboxIntent {
  readonly intentId: string;
  readonly appId: string;
  readonly action: string;
  readonly input: Record<string, unknown>;
  readonly payloadHash: string;
  readonly dependsOn?: readonly string[];
  readonly baseVersions?: Record<string, unknown>;
  readonly optimistic?: readonly unknown[];
  readonly needsBlobs?: readonly string[];
  readonly enqueuedAt?: string;
  /** Explicit only when replaying an existing queue — see `carry-over.ts`. */
  readonly createdOrder?: number;
  readonly state?: SeatOutboxState;
  readonly attempts?: number;
  readonly commitSeq?: number;
  readonly waitingOn?: Record<string, unknown>;
  readonly updatedAt?: string;
  /** The whole `ReplicaIntent`, already serialised. Set when restoring. */
  readonly record?: string;
}

/**
 * Queue an intent, or restore one.
 *
 * `created_order` defaults to one past the current maximum, so the ORDER of a
 * queue survives everything the row does not carry — including a re-bootstrap
 * that rewrites the file underneath it.
 */
export function addSeatOutboxIntent(
  driver: SeatSqliteDriver,
  intent: AddSeatOutboxIntent
): void {
  const now = intent.updatedAt ?? new Date().toISOString();
  const order =
    intent.createdOrder ??
    driver.all<{ next: number }>(
      `SELECT COALESCE(MAX(created_order), 0) + 1 AS next FROM seat_outbox`
    )[0]?.next ??
    1;
  driver.run(
    `INSERT INTO seat_outbox (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (intent_id) DO NOTHING`,
    [
      intent.intentId,
      order,
      intent.appId,
      intent.action,
      JSON.stringify(intent.input),
      intent.payloadHash,
      intent.state ?? "queued",
      intent.attempts ?? 0,
      intent.dependsOn && intent.dependsOn.length > 0
        ? JSON.stringify(intent.dependsOn)
        : null,
      intent.baseVersions ? JSON.stringify(intent.baseVersions) : null,
      intent.optimistic && intent.optimistic.length > 0
        ? JSON.stringify(intent.optimistic)
        : null,
      intent.commitSeq ?? null,
      intent.waitingOn ? JSON.stringify(intent.waitingOn) : null,
      intent.needsBlobs && intent.needsBlobs.length > 0
        ? JSON.stringify(intent.needsBlobs)
        : null,
      intent.enqueuedAt ?? now,
      now,
      intent.record ??
        JSON.stringify({
          intentId: intent.intentId,
          createdOrder: order,
          appId: intent.appId,
          action: intent.action,
          input: intent.input,
          payloadHash: intent.payloadHash,
          state: intent.state ?? "queued",
          attempts: intent.attempts ?? 0,
          optimistic: intent.optimistic ?? [],
          ...(intent.dependsOn && intent.dependsOn.length > 0
            ? { dependsOn: intent.dependsOn }
            : {}),
          ...(intent.baseVersions === undefined
            ? {}
            : { baseVersions: intent.baseVersions }),
          ...(intent.commitSeq === undefined
            ? {}
            : { commitSeq: intent.commitSeq }),
          enqueuedAt: intent.enqueuedAt ?? now,
        }),
    ]
  );
}
