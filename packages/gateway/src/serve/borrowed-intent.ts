/*
 * The audience's own outbox for a write-capable live edge (#726 P5),
 * extracted from `borrowed-store.ts` to keep that file under the repo's
 * file-size guidance (the same split `borrowed-search.ts`/`borrowed-
 * blob-ref.ts` already made).
 *
 * One row per queued intent, `borrowed_intent` (`borrowed-schema.ts`) — the
 * SAME wire shape a device's own offline intent carries
 * ({intentId, action, payloadHash, baseVersions}), because there is no
 * second vocabulary for "an action waiting to be tried." The origin's own
 * `replica_intent_outcome` is the canonical record once it answers; this
 * table is the audience's local mirror of that answer, plus whatever has
 * not yet been asked.
 */

import type { DatabaseSync } from "node:sqlite";

export type BorrowedIntentStatus =
  | "queued"
  | "sending"
  | "parked"
  | "executed"
  | "denied"
  | "failed"
  | "conflict";

/** Not yet a stable, discharged answer — a 'parked' intent still owes the
 *  origin owner's confirmation, so it is retried (as a status poll rather
 *  than a re-invoke, #726 P5) exactly like a fresh queue entry. */
const IN_PROGRESS = new Set<BorrowedIntentStatus>([
  "queued",
  "sending",
  "parked",
]);

export interface BorrowedIntentInput {
  intentId: string;
  edgeId: string;
  action: string;
  input: unknown;
  payloadHash: string;
  baseVersions?: unknown;
}

export interface BorrowedIntentRecord {
  intentId: string;
  edgeId: string;
  action: string;
  input: unknown;
  payloadHash: string;
  baseVersions?: unknown;
  status: BorrowedIntentStatus;
  invocationId?: string;
  reason?: string;
  conflict?: unknown;
  output?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface BorrowedIntentOutcomePatch {
  status: BorrowedIntentStatus;
  invocationId?: string;
  reason?: string;
  conflict?: unknown;
  output?: unknown;
}

interface IntentRow {
  intent_id: string;
  edge_id: string;
  action: string;
  input_json: string;
  payload_hash: string;
  base_versions_json: string | null;
  status: BorrowedIntentStatus;
  invocation_id: string | null;
  reason: string | null;
  conflict_json: string | null;
  output_json: string | null;
  created_at: string;
  updated_at: string;
}

function recordOf(row: IntentRow): BorrowedIntentRecord {
  return {
    intentId: row.intent_id,
    edgeId: row.edge_id,
    action: row.action,
    input: JSON.parse(row.input_json) as unknown,
    payloadHash: row.payload_hash,
    ...(row.base_versions_json === null
      ? {}
      : { baseVersions: JSON.parse(row.base_versions_json) as unknown }),
    status: row.status,
    ...(row.invocation_id === null ? {} : { invocationId: row.invocation_id }),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.conflict_json === null
      ? {}
      : { conflict: JSON.parse(row.conflict_json) as unknown }),
    ...(row.output_json === null
      ? {}
      : { output: JSON.parse(row.output_json) as unknown }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Queue one intent, or return the already-queued row untouched (#726 P5):
 *  re-submitting the same intent id is a dedupe hit, not a second entry —
 *  the immutable content columns are never overwritten by a later insert. */
export function queueBorrowedIntent(
  db: DatabaseSync,
  input: BorrowedIntentInput
): BorrowedIntentRecord {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO borrowed_intent
       (intent_id, edge_id, action, input_json, payload_hash, base_versions_json,
        status, invocation_id, reason, conflict_json, output_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(intent_id) DO NOTHING`
  ).run(
    input.intentId,
    input.edgeId,
    input.action,
    JSON.stringify(input.input),
    input.payloadHash,
    input.baseVersions === undefined
      ? null
      : JSON.stringify(input.baseVersions),
    now,
    now
  );
  return borrowedIntent(db, input.intentId)!;
}

export function borrowedIntent(
  db: DatabaseSync,
  intentId: string
): BorrowedIntentRecord | undefined {
  const row = db
    .prepare(`SELECT * FROM borrowed_intent WHERE intent_id = ?`)
    .get(intentId) as IntentRow | undefined;
  return row ? recordOf(row) : undefined;
}

/** Every intent this store still owes the origin an answer for — a
 *  drain reads this FIFO by `created_at` so an older write is not starved
 *  by a stream of newer ones. */
export function pendingBorrowedIntents(
  db: DatabaseSync,
  edgeId: string,
  limit = 50
): BorrowedIntentRecord[] {
  return (
    db
      .prepare(
        `SELECT * FROM borrowed_intent
          WHERE edge_id = ? AND status IN ('queued', 'sending', 'parked')
          ORDER BY created_at LIMIT ?`
      )
      .all(edgeId, limit) as unknown as IntentRow[]
  ).map(recordOf);
}

/** Settled or owner-confirmation outcomes a mounting device may reconcile. */
export function borrowedIntentOutcomes(
  db: DatabaseSync,
  edgeId: string,
  intentIds?: readonly string[]
): BorrowedIntentRecord[] {
  const ids = [...new Set((intentIds ?? []).filter(Boolean))];
  if (intentIds && ids.length === 0) return [];
  const idClause = intentIds
    ? ` AND intent_id IN (${ids.map(() => "?").join(", ")})`
    : "";
  return (
    db
      .prepare(
        `SELECT * FROM borrowed_intent
          WHERE edge_id = ? AND status NOT IN ('queued', 'sending')${idClause}
          ORDER BY updated_at, intent_id`
      )
      .all(edgeId, ...ids) as unknown as IntentRow[]
  ).map(recordOf);
}

/** Record the origin's answer — terminal, parked, or (on a resend that
 *  hasn't resolved yet) left exactly where it was. */
export function recordBorrowedIntentOutcome(
  db: DatabaseSync,
  intentId: string,
  patch: BorrowedIntentOutcomePatch
): BorrowedIntentRecord | undefined {
  db.prepare(
    `UPDATE borrowed_intent
        SET status = ?, invocation_id = ?, reason = ?, conflict_json = ?,
            output_json = ?, updated_at = ?
      WHERE intent_id = ?`
  ).run(
    patch.status,
    patch.invocationId ?? null,
    patch.reason ?? null,
    patch.conflict === undefined ? null : JSON.stringify(patch.conflict),
    patch.output === undefined ? null : JSON.stringify(patch.output),
    new Date().toISOString(),
    intentId
  );
  return borrowedIntent(db, intentId);
}

export function isBorrowedIntentInProgress(
  status: BorrowedIntentStatus
): boolean {
  return IN_PROGRESS.has(status);
}
