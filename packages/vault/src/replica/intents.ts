import type { DatabaseSync } from "node:sqlite";

import { beginReplicaCommit, endReplicaCommit } from "./change-log.js";

export type ReplicaIntentStatus =
  | "queued"
  | "sending"
  | "parked"
  | "executed"
  | "denied"
  | "failed"
  | "conflict";

export interface ReplicaConflict {
  shapeId?: string;
  entity: string;
  rowId: string;
  expectedVersion: number;
  actualVersion: number;
}

export interface ReplicaIntentOutcome {
  intentId: string;
  deviceId: string;
  appId: string;
  action: string;
  payloadHash: string;
  status: ReplicaIntentStatus;
  invocationId?: string;
  reason?: string;
  conflict?: ReplicaConflict;
  waitingOn?: ReplicaWaitingOn;
  answeredVersions?: readonly ReplicaAnsweredVersion[];
  /** The canonical commit this answer stands for (#996, R24). */
  commitSeq?: number;
  /** What that commit wrote, with the version each row landed at. */
  produced?: readonly ReplicaProducedRowWire[];
  /** The intents this one may not run before (#996, R23). */
  dependsOn?: readonly string[];
  /** End of the idempotency window; a retry after it is answered `expired`. */
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row an executed intent produced. The TABLE is physical and the key is a
 * JSON array in declared key order — the same spelling `replica_log` uses, so
 * a seat matches an outcome against applied rows without a second vocabulary.
 */
export interface ReplicaProducedRowWire {
  table: string;
  pk: readonly unknown[];
  rowVersion?: number;
}

/**
 * Who a parked write is waiting on, and what to call them (#929). `label` is
 * read off the LINK, so a member reads a person rather than a vault id.
 */
export interface ReplicaWaitingOn {
  /**
   * `intent` is the offline chain's own wait (#996, R23): the label is the
   * PREDECESSOR'S INTENT ID, which is the only name a seat can match its own
   * outbox against — it has no vault id for a row the create has not made yet.
   */
  seat: "owner" | "origin" | "gateway" | "intent";
  label?: string;
}

/** One ORIGIN row version an answer stands for (#929, G1). */
export interface ReplicaAnsweredVersion {
  shapeId?: string;
  entity: string;
  rowId: string;
  version: number;
}

export interface RecordReplicaIntentOutcomeInput {
  intentId: string;
  deviceId: string;
  appId: string;
  action: string;
  /** Hash of the client payload; raw payloads and secrets never enter this table. */
  payloadHash: string;
  status: ReplicaIntentStatus;
  invocationId?: string;
  reason?: string;
  conflict?: ReplicaConflict;
  waitingOn?: ReplicaWaitingOn;
  answeredVersions?: readonly ReplicaAnsweredVersion[];
  /**
   * The canonical commit this answer stands for, when the commit happened
   * SOMEWHERE ELSE (#996, R10/R24). A local execution never passes it —
   * `gateway/execution.ts` stamps it inside the canonical transaction, which
   * is the only place that knows it. A projected row's edit is executed by the
   * ORIGIN, so the number that tells this seat when its pending write has
   * landed is the origin's, carried back over the peer answer.
   */
  commitSeq?: number;
  /** The intents this one may not run before (#996, R23). */
  dependsOn?: readonly string[];
  /** End of the idempotency window; defaults to the retention window. */
  expiresAt?: string;
  now?: Date;
}

export interface IntentRow {
  intent_id: string;
  device_id: string;
  app_id: string;
  action: string;
  payload_hash: string;
  status: ReplicaIntentStatus;
  invocation_id: string | null;
  reason: string | null;
  conflict_json: string | null;
  waiting_on: string | null;
  answered_versions: string | null;
  commit_seq: number | null;
  produced_json: string | null;
  depends_on: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * THE IDEMPOTENCY WINDOW (#996, R24; open question 13).
 *
 * How long a retained outcome answers a retry. It is stated here, in the
 * protocol, rather than left to whatever the retention sweep happens to do:
 * a client needs to know how long "retry is safe" lasts, and the honest
 * answer after it lapses is `expired`, never a silent second execution.
 *
 * Thirty days, matching the log's retention floor. The two numbers are the
 * same on purpose — an outcome that outlives the log rows its `commit_seq`
 * points into can no longer tell a seat where its own effect landed.
 */
export const REPLICA_IDEMPOTENCY_WINDOW_DAYS = 30;

function defaultExpiry(now: string): string {
  return new Date(
    new Date(now).getTime() +
      REPLICA_IDEMPOTENCY_WINDOW_DAYS * 24 * 60 * 60 * 1_000
  ).toISOString();
}

/** The statuses no retry re-enters. Shared with `intent-chain.ts`. */
export const TERMINAL = new Set<ReplicaIntentStatus>([
  "executed",
  "denied",
  "failed",
  "conflict",
]);

function outcomeOf(row: IntentRow): ReplicaIntentOutcome {
  return {
    intentId: row.intent_id,
    deviceId: row.device_id,
    appId: row.app_id,
    action: row.action,
    payloadHash: row.payload_hash,
    status: row.status,
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    ...(row.reason === null ? {} : { reason: row.reason }),
    ...(row.conflict_json === null
      ? {}
      : { conflict: JSON.parse(row.conflict_json) as ReplicaConflict }),
    // TYPE, not `=== null`: a row read by a query that predates these columns
    // has `undefined` here, and `JSON.parse(undefined)` throws where the
    // absence means exactly "this outcome names none".
    ...(typeof row.waiting_on === "string"
      ? { waitingOn: JSON.parse(row.waiting_on) as ReplicaWaitingOn }
      : {}),
    ...(typeof row.answered_versions === "string"
      ? {
          answeredVersions: JSON.parse(
            row.answered_versions
          ) as ReplicaAnsweredVersion[],
        }
      : {}),
    ...(typeof row.commit_seq === "number"
      ? { commitSeq: row.commit_seq }
      : {}),
    ...(typeof row.produced_json === "string"
      ? {
          produced: JSON.parse(row.produced_json) as ReplicaProducedRowWire[],
        }
      : {}),
    ...(typeof row.depends_on === "string"
      ? { dependsOn: JSON.parse(row.depends_on) as string[] }
      : {}),
    ...(typeof row.expires_at === "string"
      ? { expiresAt: row.expires_at }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function intentRowById(
  vault: DatabaseSync,
  intentId: string
): IntentRow | undefined {
  return vault
    .prepare(
      `SELECT intent_id, device_id, app_id, action, payload_hash, status,
              invocation_id, reason, conflict_json, waiting_on,
              answered_versions, commit_seq, produced_json, depends_on,
              expires_at, created_at, updated_at
         FROM replica_intent_outcome WHERE intent_id = ?`
    )
    .get(intentId) as IntentRow | undefined;
}

/**
 * WHY AN ADMISSION WAS REFUSED, SAID IN A TYPE (#1014, X20).
 *
 * The identity refusals below are the caller's fault and are fixed by minting
 * a new id; every other throw out of this module is the vault's — a write that
 * did not run. A door that cannot tell them apart answers both the same, and
 * the device door answered both `202 in-flight`: an acknowledgement of a write
 * that will never happen, which is the shape of silent loss. `code` is what a
 * route puts on the wire.
 */
export class ReplicaIntentIdentityError extends Error {
  constructor(
    readonly code: "intent_id_reused" | "intent_already_terminal",
    message: string
  ) {
    super(message);
    this.name = "ReplicaIntentIdentityError";
  }
}

function assertIdentity(
  prior: IntentRow,
  input: RecordReplicaIntentOutcomeInput
): void {
  if (
    prior.device_id !== input.deviceId ||
    prior.app_id !== input.appId ||
    prior.action !== input.action ||
    prior.payload_hash !== input.payloadHash
  ) {
    throw new ReplicaIntentIdentityError(
      "intent_id_reused",
      `replica intent ${input.intentId} was replayed with different immutable fields`
    );
  }
  if (TERMINAL.has(prior.status) && prior.status !== input.status) {
    throw new ReplicaIntentIdentityError(
      "intent_already_terminal",
      `replica intent ${input.intentId} is already terminal (${prior.status}); refusing ${input.status}`
    );
  }
}

/**
 * Record one outcome inside the caller's transaction. The table's replica
 * trigger appends the observable `replica.intent` entry atomically.
 */
export function recordReplicaIntentOutcomeInTransaction(
  vault: DatabaseSync,
  input: RecordReplicaIntentOutcomeInput
): ReplicaIntentOutcome {
  if (
    !input.intentId ||
    !input.deviceId ||
    !input.appId ||
    !input.action ||
    !input.payloadHash
  ) {
    throw new Error("replica intent identity fields must be non-empty");
  }
  const prior = intentRowById(vault, input.intentId);
  if (prior) assertIdentity(prior, input);
  const now = (input.now ?? new Date()).toISOString();
  if (prior) {
    vault
      .prepare(
        `UPDATE replica_intent_outcome
            SET status = ?, invocation_id = ?, reason = ?, conflict_json = ?,
                waiting_on = ?, answered_versions = ?,
                commit_seq = COALESCE(?, commit_seq),
                depends_on = COALESCE(?, depends_on),
                expires_at = COALESCE(?, expires_at),
                updated_at = ?
          WHERE intent_id = ?`
      )
      .run(
        input.status,
        input.invocationId ?? null,
        input.reason ?? null,
        input.conflict ? JSON.stringify(input.conflict) : null,
        input.waitingOn ? JSON.stringify(input.waitingOn) : null,
        input.answeredVersions ? JSON.stringify(input.answeredVersions) : null,
        input.commitSeq ?? null,
        input.dependsOn ? JSON.stringify(input.dependsOn) : null,
        input.expiresAt ?? null,
        now,
        input.intentId
      );
  } else {
    vault
      .prepare(
        `INSERT INTO replica_intent_outcome (
           intent_id, device_id, app_id, action, payload_hash, status,
           invocation_id, reason, conflict_json, waiting_on, answered_versions,
           commit_seq, depends_on, expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.intentId,
        input.deviceId,
        input.appId,
        input.action,
        input.payloadHash,
        input.status,
        input.invocationId ?? null,
        input.reason ?? null,
        input.conflict ? JSON.stringify(input.conflict) : null,
        input.waitingOn ? JSON.stringify(input.waitingOn) : null,
        input.answeredVersions ? JSON.stringify(input.answeredVersions) : null,
        input.commitSeq ?? null,
        input.dependsOn ? JSON.stringify(input.dependsOn) : null,
        input.expiresAt ?? defaultExpiry(now),
        now,
        now
      );
  }
  // A terminal device outcome proves protocol dedupe, but it does not prove
  // the audit band survived the post-canonical crash window. Reclaim only a
  // marker whose atomic audit repair has been verified and proof-stamped.
  if (TERMINAL.has(input.status)) {
    vault
      .prepare(
        `DELETE FROM replica_invocation_commit
          WHERE intent_id = ? AND journal_finalized_at IS NOT NULL`
      )
      .run(input.intentId);
  }
  const row = intentRowById(vault, input.intentId);
  if (!row)
    throw new Error(
      `replica intent ${input.intentId} disappeared while recording`
    );
  return outcomeOf(row);
}

/** Record one outcome as its own durable transaction. */
export function recordReplicaIntentOutcome(
  vault: DatabaseSync,
  input: RecordReplicaIntentOutcomeInput
): ReplicaIntentOutcome {
  vault.exec("BEGIN IMMEDIATE");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(vault);
    const outcome = recordReplicaIntentOutcomeInTransaction(vault, input);
    endReplicaCommit(vault, replicaCommit);
    vault.exec("COMMIT");
    return outcome;
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
}

export interface TransitionReplicaIntentOutcomeInput {
  status: ReplicaIntentStatus;
  invocationId?: string;
  reason?: string;
  conflict?: ReplicaConflict;
  waitingOn?: ReplicaWaitingOn;
  answeredVersions?: readonly ReplicaAnsweredVersion[];
  now?: Date;
}

/**
 * Transition an already-admitted intent while retaining its immutable
 * device/app/action/hash identity. Owner confirmation uses this path days
 * after the original HTTP request is gone.
 */
export function transitionReplicaIntentOutcomeInTransaction(
  vault: DatabaseSync,
  intentId: string,
  update: TransitionReplicaIntentOutcomeInput
): ReplicaIntentOutcome | undefined {
  const prior = intentRowById(vault, intentId);
  if (!prior) return undefined;
  // A TRANSITION FORWARDS WHAT IT DOES NOT REPLACE (#1014, G18/B16). The
  // UPDATE below binds `waiting_on` and `answered_versions` unconditionally,
  // so a transition that named neither used to ERASE both — and `waiting_on`
  // is the field `replica-intent-route.ts` reads to decide whether a chain
  // park is re-enterable, so a re-park lost the fact that it was waiting on an
  // INTENT rather than on a person and became an immutable dedupe hit: the
  // queue behind a slow predecessor never drained again.
  //
  // `waiting_on` carries over only while the outcome is STILL A WAIT. A park
  // that has become `failed` or `executed` is waiting on nobody, and saying
  // otherwise would put a name under a settled row.
  const carriedWait =
    update.status === "parked" && typeof prior.waiting_on === "string"
      ? (JSON.parse(prior.waiting_on) as ReplicaWaitingOn)
      : undefined;
  // The version set a seat clears its badge against belongs to the ANSWER, not
  // to the status; a transition that does not restate it keeps it.
  const carriedVersions =
    typeof prior.answered_versions === "string"
      ? (JSON.parse(prior.answered_versions) as ReplicaAnsweredVersion[])
      : undefined;
  const waitingOn = update.waitingOn ?? carriedWait;
  const answeredVersions = update.answeredVersions ?? carriedVersions;
  return recordReplicaIntentOutcomeInTransaction(vault, {
    intentId,
    deviceId: prior.device_id,
    appId: prior.app_id,
    action: prior.action,
    payloadHash: prior.payload_hash,
    status: update.status,
    ...(update.invocationId ? { invocationId: update.invocationId } : {}),
    ...(update.reason ? { reason: update.reason } : {}),
    ...(update.conflict ? { conflict: update.conflict } : {}),
    ...(waitingOn ? { waitingOn } : {}),
    ...(answeredVersions ? { answeredVersions } : {}),
    ...(update.now ? { now: update.now } : {}),
  });
}

/** Transition an admitted intent as its own durable transaction. */
export function transitionReplicaIntentOutcome(
  vault: DatabaseSync,
  intentId: string,
  update: TransitionReplicaIntentOutcomeInput
): ReplicaIntentOutcome | undefined {
  vault.exec("BEGIN IMMEDIATE");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(vault);
    const outcome = transitionReplicaIntentOutcomeInTransaction(
      vault,
      intentId,
      update
    );
    endReplicaCommit(vault, replicaCommit);
    vault.exec("COMMIT");
    return outcome;
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
}

/** Device-scoped read; a wrong device id is indistinguishable from absence. */
export function readReplicaIntentOutcome(
  vault: DatabaseSync,
  intentId: string,
  deviceId: string
): ReplicaIntentOutcome | undefined {
  const row = intentRowById(vault, intentId);
  return row?.device_id === deviceId ? outcomeOf(row) : undefined;
}

export interface ListReplicaIntentOutcomesOptions {
  status?: ReplicaIntentStatus;
  limit?: number;
}

/** Device-scoped recovery list for reconnecting an outbox. */
export function listReplicaIntentOutcomes(
  vault: DatabaseSync,
  deviceId: string,
  options: ListReplicaIntentOutcomesOptions = {}
): ReplicaIntentOutcome[] {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new RangeError(
      "replica intent list limit must be an integer between 1 and 5000"
    );
  }
  // EVERY COLUMN, BECAUSE THIS IS THE RECOVERY READ (#1014, G19). It used to
  // select nine of the sixteen, so an outcome recovered here arrived without
  // its commit position, its produced set, who it waits on, the versions it
  // answers for or the end of its idempotency window — the server-side twin
  // of R1, and one that survives any client fix: a seat cannot park on a
  // number the answer did not carry. `intentRowById` names the same list.
  const columns = `intent_id, device_id, app_id, action, payload_hash, status,
                   invocation_id, reason, conflict_json, waiting_on,
                   answered_versions, commit_seq, produced_json, depends_on,
                   expires_at, created_at, updated_at`;
  const rows = options.status
    ? (vault
        .prepare(
          `SELECT ${columns}
             FROM replica_intent_outcome
            WHERE device_id = ? AND status = ? ORDER BY updated_at, intent_id LIMIT ?`
        )
        .all(deviceId, options.status, limit) as unknown as IntentRow[])
    : (vault
        .prepare(
          `SELECT ${columns}
             FROM replica_intent_outcome
            WHERE device_id = ? ORDER BY updated_at, intent_id LIMIT ?`
        )
        .all(deviceId, limit) as unknown as IntentRow[]);
  return rows.map(outcomeOf);
}

/** Wipe protocol outcomes when a device is revoked or unpaired. */
export function deleteReplicaIntentOutcomesForDevice(
  vault: DatabaseSync,
  deviceId: string
): number {
  vault.exec("BEGIN IMMEDIATE");
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(vault);
    // A parked payload is executable authority, not merely presentation
    // state. Remove it while the device -> intent ownership rows still exist,
    // in the same transaction that forgets those rows. Once a device is
    // revoked or unpaired, an owner must not be able to approve its old act.
    vault
      .prepare(
        `DELETE FROM replica_parked_payload
          WHERE intent_id IN (
            SELECT intent_id FROM replica_intent_outcome WHERE device_id = ?
          )`
      )
      .run(deviceId);
    // Revocation removes device-visible outcomes, but an unfinished marker
    // must survive so startup repair cannot mistake protocol deletion for a
    // complete journal audit. Detach it from the now-deleted device intent:
    // after journal proof is stamped it follows the ordinary non-intent GC
    // rule, while the marker itself is never removed before that proof.
    vault
      .prepare(
        `UPDATE replica_invocation_commit
            SET intent_id = NULL
          WHERE journal_finalized_at IS NULL
            AND intent_id IN (
              SELECT intent_id FROM replica_intent_outcome WHERE device_id = ?
            )`
      )
      .run(deviceId);
    // Already proof-stamped markers are disposable under the existing device
    // revocation rule and need no startup work.
    vault
      .prepare(
        `DELETE FROM replica_invocation_commit
          WHERE journal_finalized_at IS NOT NULL
            AND intent_id IN (
            SELECT intent_id FROM replica_intent_outcome WHERE device_id = ?
          )`
      )
      .run(deviceId);
    const deleted = Number(
      vault
        .prepare(`DELETE FROM replica_intent_outcome WHERE device_id = ?`)
        .run(deviceId).changes
    );
    endReplicaCommit(vault, replicaCommit);
    vault.exec("COMMIT");
    return deleted;
  } catch (error) {
    vault.exec("ROLLBACK");
    throw error;
  }
}
