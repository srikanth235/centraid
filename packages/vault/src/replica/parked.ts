import type { VaultDb } from '../db.js';
import type { Identity, InvokeRequest } from '../gateway/types.js';
import { writeExplanation, writeReceipt } from '../gateway/evidence.js';
import { sealAad, sealValue, unsealValue } from '../schema/sealed.js';
import {
  transitionReplicaIntentOutcomeInTransaction,
  type ReplicaIntentOutcome,
  type TransitionReplicaIntentOutcomeInput,
} from './intents.js';

export interface DurableParkedPayload {
  invocationId: string;
  intentId?: string;
  identity: Identity;
  request: InvokeRequest;
  grantId: string | null;
  commandId: string;
  commandName: string;
  reason: string;
  parkedAt: string;
}

interface ParkedRow {
  invocation_id: string;
  intent_id: string | null;
  identity_json: string;
  request_sealed: string;
  grant_id: string | null;
  command_id: string;
  command_name: string;
  reason: string;
  parked_at: string;
}

function aad(invocationId: string): string {
  return sealAad('replica_parked_payload', 'request_sealed', invocationId);
}

function payloadOf(db: VaultDb, row: ParkedRow): DurableParkedPayload {
  const request = JSON.parse(
    unsealValue(db.sealKey, aad(row.invocation_id), row.request_sealed),
  ) as InvokeRequest;
  return {
    invocationId: row.invocation_id,
    ...(row.intent_id ? { intentId: row.intent_id } : {}),
    identity: JSON.parse(row.identity_json) as Identity,
    request,
    grantId: row.grant_id,
    commandId: row.command_id,
    commandName: row.command_name,
    reason: row.reason,
    parkedAt: row.parked_at,
  };
}

const SELECT = `SELECT invocation_id, intent_id, identity_json, request_sealed,
  grant_id, command_id, command_name, reason, parked_at
  FROM replica_parked_payload`;

/** Persist the encrypted resumption payload before returning `parked`. */
export function saveDurableParkedPayload(
  db: VaultDb,
  payload: DurableParkedPayload,
): DurableParkedPayload {
  const requestJson = JSON.stringify(payload.request);
  const identityJson = JSON.stringify(payload.identity);
  db.vault
    .prepare(
      `INSERT INTO replica_parked_payload (
         invocation_id, intent_id, identity_json, request_sealed, grant_id,
         command_id, command_name, reason, parked_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(invocation_id) DO UPDATE SET
         intent_id=excluded.intent_id,
         identity_json=excluded.identity_json,
         request_sealed=excluded.request_sealed,
         grant_id=excluded.grant_id,
         command_id=excluded.command_id,
         command_name=excluded.command_name,
         reason=excluded.reason,
         parked_at=excluded.parked_at`,
    )
    .run(
      payload.invocationId,
      payload.intentId ?? null,
      identityJson,
      sealValue(db.sealKey, aad(payload.invocationId), requestJson),
      payload.grantId,
      payload.commandId,
      payload.commandName,
      payload.reason,
      payload.parkedAt,
    );
  return payload;
}

export function readDurableParkedPayload(
  db: VaultDb,
  invocationId: string,
): DurableParkedPayload | undefined {
  const row = db.vault.prepare(`${SELECT} WHERE invocation_id = ?`).get(invocationId) as
    | ParkedRow
    | undefined;
  return row ? payloadOf(db, row) : undefined;
}

export function listDurableParkedPayloads(db: VaultDb): DurableParkedPayload[] {
  const rows = db.vault
    .prepare(`${SELECT} ORDER BY parked_at, invocation_id`)
    .all() as unknown as ParkedRow[];
  return rows.map((row) => payloadOf(db, row));
}

export function deleteDurableParkedPayload(db: VaultDb, invocationId: string): boolean {
  return (
    db.vault.prepare('DELETE FROM replica_parked_payload WHERE invocation_id = ?').run(invocationId)
      .changes > 0
  );
}

export interface DurableParkedDenial {
  invocationId: string;
  receiptId: string;
  reason: string;
}

interface ParkedDenialReceiptRow {
  receipt_id: string;
  detail_json: string | null;
}

/**
 * Read a journal-proven terminal denial for a formerly parked invocation.
 * This check deliberately does not depend on vault settlement: journal.db is
 * the first side committed by confirmation denial, so it is the recovery
 * authority if the process dies before payload deletion/outcome publication.
 */
export function readDurableParkedDenial(
  db: VaultDb,
  invocationId: string,
): DurableParkedDenial | undefined {
  const invocation = db.journal
    .prepare('SELECT status FROM agent_command_invocation WHERE invocation_id = ?')
    .get(invocationId) as { status: string } | undefined;
  if (invocation?.status !== 'failed') return undefined;
  const receipts = db.journal
    .prepare(
      `SELECT receipt_id, detail_json
         FROM consent_receipt
        WHERE invocation_id = ? AND decision = 'deny'
        ORDER BY receipt_id`,
    )
    .all(invocationId) as unknown as ParkedDenialReceiptRow[];
  if (receipts.length > 1) {
    throw new Error(`parked invocation ${invocationId} has multiple denial receipts`);
  }
  const receipt = receipts[0];
  if (!receipt) return undefined;
  let reason = 'owner denied confirmation';
  if (receipt.detail_json) {
    const detail = JSON.parse(receipt.detail_json) as { failing?: unknown };
    if (typeof detail.failing === 'string' && detail.failing.length > 0) reason = detail.failing;
  }
  return { invocationId, receiptId: receipt.receipt_id, reason };
}

export interface RecordDurableParkedDenialInput {
  payload: DurableParkedPayload;
  confirmedBy: string | null;
  confirmedAt: string;
  reason: string;
}

/**
 * Atomically write the complete journal side of a parked denial. Retrying
 * after this commit returns the existing receipt instead of appending a
 * second receipt/explanation. The vault payload is settled separately and
 * may safely lag this transaction across a crash.
 */
export function recordDurableParkedDenial(
  db: VaultDb,
  input: RecordDurableParkedDenialInput,
): DurableParkedDenial {
  const { payload } = input;
  db.journal.exec('BEGIN IMMEDIATE');
  try {
    const existing = readDurableParkedDenial(db, payload.invocationId);
    if (existing) {
      db.journal.exec('COMMIT');
      return existing;
    }
    const invocation = db.journal
      .prepare('SELECT status, command_id FROM agent_command_invocation WHERE invocation_id = ?')
      .get(payload.invocationId) as { status: string; command_id: string } | undefined;
    if (!invocation || invocation.command_id !== payload.commandId) {
      throw new Error(`parked invocation ${payload.invocationId} conflicts with its journal row`);
    }
    if (invocation.status === 'executed' || invocation.status === 'failed') {
      throw new Error(`parked invocation ${payload.invocationId} is already ${invocation.status}`);
    }
    const receiptId = writeReceipt(db.journal, {
      grantId: payload.grantId,
      invocationId: payload.invocationId,
      action: `act ${payload.commandName}`,
      objectType: 'agent.command',
      objectId: payload.commandId,
      purpose: payload.request.purpose,
      decision: 'deny',
      detail: {
        failing: input.reason,
        confirmedBy: input.confirmedBy,
        confirmedAt: input.confirmedAt,
      },
    });
    writeExplanation(
      db.journal,
      payload.invocationId,
      input.reason === 'owner denied confirmation'
        ? `Owner denied ${payload.commandName} at confirmation.`
        : `${payload.commandName} could not be confirmed: ${input.reason}.`,
    );
    db.journal
      .prepare(
        `UPDATE agent_command_invocation
            SET status = 'failed', receipt_id = ?
          WHERE invocation_id = ?`,
      )
      .run(receiptId, payload.invocationId);
    db.journal.exec('COMMIT');
    return { invocationId: payload.invocationId, receiptId, reason: input.reason };
  } catch (error) {
    db.journal.exec('ROLLBACK');
    throw error;
  }
}

export interface DurableParkedIntentSettlement {
  intentId: string;
  outcome: TransitionReplicaIntentOutcomeInput;
}

/**
 * Remove a resumable confirmation payload and publish its terminal device
 * outcome atomically. A crash may leave both pending or both settled, never a
 * permanently parked outcome whose encrypted resumption payload is gone.
 */
export function settleDurableParkedPayload(
  db: VaultDb,
  invocationId: string,
  settlement?: DurableParkedIntentSettlement,
): { deleted: boolean; outcome?: ReplicaIntentOutcome } {
  db.vault.exec('BEGIN IMMEDIATE');
  try {
    const deleted = deleteDurableParkedPayload(db, invocationId);
    const outcome = settlement
      ? transitionReplicaIntentOutcomeInTransaction(
          db.vault,
          settlement.intentId,
          settlement.outcome,
        )
      : undefined;
    db.vault.exec('COMMIT');
    return { deleted, ...(outcome ? { outcome } : {}) };
  } catch (error) {
    db.vault.exec('ROLLBACK');
    throw error;
  }
}

/** Delete every pending payload riding a revoked grant; returns invocation ids. */
export function deleteDurableParkedPayloadsForGrant(db: VaultDb, grantId: string): string[] {
  const rows = db.vault
    .prepare('SELECT invocation_id FROM replica_parked_payload WHERE grant_id = ?')
    .all(grantId) as unknown as { invocation_id: string }[];
  db.vault.prepare('DELETE FROM replica_parked_payload WHERE grant_id = ?').run(grantId);
  return rows.map((row) => row.invocation_id);
}
