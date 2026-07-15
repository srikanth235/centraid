import type { DatabaseSync } from 'node:sqlite';

export type ReplicaIntentStatus =
  | 'queued'
  | 'sending'
  | 'parked'
  | 'executed'
  | 'denied'
  | 'failed';

export interface ReplicaIntentOutcome {
  intentId: string;
  deviceId: string;
  appId: string;
  action: string;
  payloadHash: string;
  status: ReplicaIntentStatus;
  invocationId?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
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
  now?: Date;
}

interface IntentRow {
  intent_id: string;
  device_id: string;
  app_id: string;
  action: string;
  payload_hash: string;
  status: ReplicaIntentStatus;
  invocation_id: string | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

const TERMINAL = new Set<ReplicaIntentStatus>(['executed', 'denied', 'failed']);

function outcomeOf(row: IntentRow): ReplicaIntentOutcome {
  return {
    intentId: row.intent_id,
    deviceId: row.device_id,
    appId: row.app_id,
    action: row.action,
    payloadHash: row.payload_hash,
    status: row.status,
    ...(row.invocation_id ? { invocationId: row.invocation_id } : {}),
    ...(row.reason !== null ? { reason: row.reason } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowById(vault: DatabaseSync, intentId: string): IntentRow | undefined {
  return vault
    .prepare(
      `SELECT intent_id, device_id, app_id, action, payload_hash, status,
              invocation_id, reason, created_at, updated_at
         FROM replica_intent_outcome WHERE intent_id = ?`,
    )
    .get(intentId) as IntentRow | undefined;
}

function assertIdentity(prior: IntentRow, input: RecordReplicaIntentOutcomeInput): void {
  if (
    prior.device_id !== input.deviceId ||
    prior.app_id !== input.appId ||
    prior.action !== input.action ||
    prior.payload_hash !== input.payloadHash
  ) {
    throw new Error(
      `replica intent ${input.intentId} was replayed with different immutable fields`,
    );
  }
  if (TERMINAL.has(prior.status) && prior.status !== input.status) {
    throw new Error(
      `replica intent ${input.intentId} is already terminal (${prior.status}); refusing ${input.status}`,
    );
  }
}

/**
 * Record one outcome inside the caller's transaction. The table's replica
 * trigger appends the observable `replica.intent` entry atomically.
 */
export function recordReplicaIntentOutcomeInTransaction(
  vault: DatabaseSync,
  input: RecordReplicaIntentOutcomeInput,
): ReplicaIntentOutcome {
  if (!input.intentId || !input.deviceId || !input.appId || !input.action || !input.payloadHash) {
    throw new Error('replica intent identity fields must be non-empty');
  }
  const prior = rowById(vault, input.intentId);
  if (prior) assertIdentity(prior, input);
  const now = (input.now ?? new Date()).toISOString();
  if (prior) {
    vault
      .prepare(
        `UPDATE replica_intent_outcome
            SET status = ?, invocation_id = ?, reason = ?, updated_at = ?
          WHERE intent_id = ?`,
      )
      .run(input.status, input.invocationId ?? null, input.reason ?? null, now, input.intentId);
  } else {
    vault
      .prepare(
        `INSERT INTO replica_intent_outcome (
           intent_id, device_id, app_id, action, payload_hash, status,
           invocation_id, reason, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        now,
        now,
      );
  }
  // A terminal device outcome proves protocol dedupe, but it does not prove
  // journal.db survived the post-canonical crash window. Reclaim only a
  // marker whose atomic journal repair has been verified and proof-stamped.
  if (TERMINAL.has(input.status)) {
    vault
      .prepare(
        `DELETE FROM replica_invocation_commit
          WHERE intent_id = ? AND journal_finalized_at IS NOT NULL`,
      )
      .run(input.intentId);
  }
  const row = rowById(vault, input.intentId);
  if (!row) throw new Error(`replica intent ${input.intentId} disappeared while recording`);
  return outcomeOf(row);
}

/** Record one outcome as its own durable transaction. */
export function recordReplicaIntentOutcome(
  vault: DatabaseSync,
  input: RecordReplicaIntentOutcomeInput,
): ReplicaIntentOutcome {
  vault.exec('BEGIN IMMEDIATE');
  try {
    const outcome = recordReplicaIntentOutcomeInTransaction(vault, input);
    vault.exec('COMMIT');
    return outcome;
  } catch (error) {
    vault.exec('ROLLBACK');
    throw error;
  }
}

export interface TransitionReplicaIntentOutcomeInput {
  status: ReplicaIntentStatus;
  invocationId?: string;
  reason?: string;
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
  update: TransitionReplicaIntentOutcomeInput,
): ReplicaIntentOutcome | undefined {
  const prior = rowById(vault, intentId);
  if (!prior) return undefined;
  return recordReplicaIntentOutcomeInTransaction(vault, {
    intentId,
    deviceId: prior.device_id,
    appId: prior.app_id,
    action: prior.action,
    payloadHash: prior.payload_hash,
    status: update.status,
    ...(update.invocationId ? { invocationId: update.invocationId } : {}),
    ...(update.reason ? { reason: update.reason } : {}),
    ...(update.now ? { now: update.now } : {}),
  });
}

/** Transition an admitted intent as its own durable transaction. */
export function transitionReplicaIntentOutcome(
  vault: DatabaseSync,
  intentId: string,
  update: TransitionReplicaIntentOutcomeInput,
): ReplicaIntentOutcome | undefined {
  vault.exec('BEGIN IMMEDIATE');
  try {
    const outcome = transitionReplicaIntentOutcomeInTransaction(vault, intentId, update);
    vault.exec('COMMIT');
    return outcome;
  } catch (error) {
    vault.exec('ROLLBACK');
    throw error;
  }
}

/** Device-scoped read; a wrong device id is indistinguishable from absence. */
export function readReplicaIntentOutcome(
  vault: DatabaseSync,
  intentId: string,
  deviceId: string,
): ReplicaIntentOutcome | undefined {
  const row = rowById(vault, intentId);
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
  options: ListReplicaIntentOutcomesOptions = {},
): ReplicaIntentOutcome[] {
  const limit = options.limit ?? 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5_000) {
    throw new RangeError('replica intent list limit must be an integer between 1 and 5000');
  }
  const rows = options.status
    ? (vault
        .prepare(
          `SELECT intent_id, device_id, app_id, action, payload_hash, status,
                  invocation_id, reason, created_at, updated_at
             FROM replica_intent_outcome
            WHERE device_id = ? AND status = ? ORDER BY updated_at, intent_id LIMIT ?`,
        )
        .all(deviceId, options.status, limit) as unknown as IntentRow[])
    : (vault
        .prepare(
          `SELECT intent_id, device_id, app_id, action, payload_hash, status,
                  invocation_id, reason, created_at, updated_at
             FROM replica_intent_outcome
            WHERE device_id = ? ORDER BY updated_at, intent_id LIMIT ?`,
        )
        .all(deviceId, limit) as unknown as IntentRow[]);
  return rows.map(outcomeOf);
}

/** Wipe protocol outcomes when a device is revoked or unpaired. */
export function deleteReplicaIntentOutcomesForDevice(
  vault: DatabaseSync,
  deviceId: string,
): number {
  vault.exec('BEGIN IMMEDIATE');
  try {
    // A parked payload is executable authority, not merely presentation
    // state. Remove it while the device -> intent ownership rows still exist,
    // in the same transaction that forgets those rows. Once a device is
    // revoked or unpaired, an owner must not be able to approve its old act.
    vault
      .prepare(
        `DELETE FROM replica_parked_payload
          WHERE intent_id IN (
            SELECT intent_id FROM replica_intent_outcome WHERE device_id = ?
          )`,
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
            )`,
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
          )`,
      )
      .run(deviceId);
    const deleted = Number(
      vault.prepare(`DELETE FROM replica_intent_outcome WHERE device_id = ?`).run(deviceId).changes,
    );
    vault.exec('COMMIT');
    return deleted;
  } catch (error) {
    vault.exec('ROLLBACK');
    throw error;
  }
}
