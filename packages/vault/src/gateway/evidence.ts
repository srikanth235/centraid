// S5 — Evidence: every read and every command leaves rows, allowed or
// denied. Receipts (Kantara-style, hash-chained), provenance (W3C PROV) per
// write, evidence + explanation per invocation. Unskippable because there is
// no other door. All writers here append to journal.db and never UPDATE.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, sha256Hex, uuidv7 } from '../ids.js';
import type { Citation, Identity } from './types.js';

export interface ReceiptInput {
  grantId: string | null;
  invocationId: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  /** The purpose that APPLIED — callers record the defaulted notation (issue #306). */
  purpose: string | null | undefined;
  decision: 'allow' | 'deny';
  detail?: Record<string, unknown>;
}

/** Append a consent.receipt, chaining its hash to the previous receipt. */
export function writeReceipt(journal: DatabaseSync, input: ReceiptInput): string {
  const receiptId = uuidv7();
  const occurredAt = nowIso();
  const prev = journal
    .prepare('SELECT hash FROM consent_receipt ORDER BY receipt_id DESC LIMIT 1')
    .get() as { hash: string } | undefined;
  const hash = sha256Hex(
    JSON.stringify([
      prev?.hash ?? '',
      receiptId,
      input.action,
      input.objectType,
      input.objectId,
      input.decision,
      occurredAt,
    ]),
  );
  journal
    .prepare(
      `INSERT INTO consent_receipt
         (receipt_id, grant_id, invocation_id, action, object_type, object_id, purpose_concept_id, decision, occurred_at, hash, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      receiptId,
      input.grantId,
      input.invocationId,
      input.action,
      input.objectType,
      input.objectId,
      input.purpose ?? null,
      input.decision,
      occurredAt,
      hash,
      input.detail ? JSON.stringify(input.detail) : null,
    );
  return receiptId;
}

/**
 * Append consent.provenance for one written row, chained per entity. Ingest
 * passes agentKind 'import' (W3C PROV agent class) regardless of which
 * enrolled identity carried the batch in.
 */
export function writeProvenance(
  journal: DatabaseSync,
  identity: Identity,
  entityType: string,
  entityId: string,
  activity: string,
  used?: Record<string, unknown>,
  agentKind?: 'owner' | 'app' | 'ai_agent' | 'import',
): string {
  const provId = uuidv7();
  const prev = journal
    .prepare(
      'SELECT prov_id FROM consent_provenance WHERE entity_type = ? AND entity_id = ? ORDER BY prov_id DESC LIMIT 1',
    )
    .get(entityType, entityId) as { prov_id: string } | undefined;
  journal
    .prepare(
      `INSERT INTO consent_provenance
         (prov_id, entity_type, entity_id, prov_activity, agent_kind, agent_id, used_json, occurred_at, prev_prov_id, signature)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      provId,
      entityType,
      entityId,
      activity,
      agentKind ?? identity.provAgentKind,
      identity.callerId,
      used ? JSON.stringify(used) : null,
      nowIso(),
      prev?.prov_id ?? null,
    );
  return provId;
}

/** Append an agent.invocation_check row (pre or post, S3/S4). */
export function writeCheck(
  journal: DatabaseSync,
  invocationId: string,
  phase: 'pre' | 'post',
  predicate: string,
  passed: boolean,
  observed?: Record<string, unknown>,
): void {
  journal
    .prepare(
      `INSERT INTO agent_invocation_check (check_id, invocation_id, phase, predicate, passed, observed_json, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuidv7(),
      invocationId,
      phase,
      predicate,
      passed ? 1 : 0,
      observed ? JSON.stringify(observed) : null,
      nowIso(),
    );
}

/** Append agent.evidence rows for a command's citations. */
export function writeEvidence(
  journal: DatabaseSync,
  invocationId: string,
  citations: Citation[],
): void {
  const stmt = journal.prepare(
    `INSERT INTO agent_evidence (evidence_id, invocation_id, claim, entity_type, entity_id, prov_id, weight)
     VALUES (?, ?, ?, ?, ?, NULL, ?)`,
  );
  for (const c of citations) {
    stmt.run(uuidv7(), invocationId, c.claim, c.entityType, c.entityId, c.weight ?? null);
  }
}

/** Append the one agent.explanation for an invocation. */
export function writeExplanation(
  journal: DatabaseSync,
  invocationId: string,
  summary: string,
): void {
  journal
    .prepare(
      `INSERT INTO agent_explanation (explanation_id, invocation_id, audience, summary, generated_at)
       VALUES (?, ?, 'owner', ?, ?)`,
    )
    .run(uuidv7(), invocationId, summary, nowIso());
}
