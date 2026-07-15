import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { nowIso } from '../ids.js';
import type { Identity } from '../gateway/types.js';
import {
  writeCheck,
  writeEvidence,
  writeExplanation,
  writeProvenance,
  writeReceipt,
} from '../gateway/evidence.js';

type InvocationDatabases = Pick<VaultDb, 'vault' | 'journal'>;

/** Keep each startup read/repair page small while still draining every page. */
export const DEFAULT_REPLICA_INVOCATION_REPAIR_BATCH_SIZE = 128;
const MAX_REPLICA_INVOCATION_REPAIR_BATCH_SIZE = 5_000;

export interface ReplicaInvocationAuditCheck {
  predicate: string;
  passed: boolean;
  observed: Record<string, unknown>;
}

export interface ReplicaInvocationAuditWrite {
  entityType: string;
  entityId: string;
}

export interface ReplicaInvocationAuditCitation {
  claim: string;
  entityType: string;
  entityId: string;
  weight?: number;
}

/**
 * S5 material captured in vault.db beside the canonical mutation. Raw command
 * input is always absent. Replica callers also omit all handler output so the
 * marker cannot become a second device data plane; ordinary online callers
 * retain their established receipt replay value (with transcript-sensitive
 * output redacted). This is enough to finish the audit trail without
 * re-running the handler after a crash between the two database commits.
 */
export interface ReplicaInvocationAudit {
  commandName: string;
  agentId: string;
  agentKind: 'owner' | 'app' | 'ai_agent';
  grantId: string | null;
  purpose: string | null;
  preconditionCount: number;
  postChecks: ReplicaInvocationAuditCheck[];
  writes: ReplicaInvocationAuditWrite[];
  citations: ReplicaInvocationAuditCitation[];
  provenance: { activity: string; used: Record<string, unknown> };
  receiptDetail: Record<string, unknown>;
}

export interface ReplicaInvocationCommit {
  invocationId: string;
  commandId: string;
  intentId?: string;
  audit: ReplicaInvocationAudit;
  committedAt: string;
  journalFinalizedAt?: string;
}

export interface ReplicaInvocationRepairFailure {
  invocationId: string;
  reason: string;
}

export interface ReplicaInvocationRepairResult {
  scanned: number;
  finalized: number;
  reclaimed: number;
  retained: number;
  remaining: number;
  failures: ReplicaInvocationRepairFailure[];
}

/** Opening fails closed if canonical commits still lack journal proof. */
export class ReplicaInvocationRepairError extends Error {
  readonly result: ReplicaInvocationRepairResult;

  constructor(result: ReplicaInvocationRepairResult) {
    super(
      `replica invocation startup repair retained ${result.remaining} unfinished marker(s)` +
        (result.failures.length > 0 ? `; ${result.failures.length} repair attempt(s) failed` : ''),
    );
    this.name = 'ReplicaInvocationRepairError';
    this.result = result;
  }
}

export interface RecordReplicaInvocationCommitInput {
  invocationId: string;
  commandId: string;
  intentId?: string;
  audit: ReplicaInvocationAudit;
  committedAt: string;
}

interface InvocationCommitRow {
  invocation_id: string;
  command_id: string;
  intent_id: string | null;
  audit_json: string;
  committed_at: string;
  journal_finalized_at: string | null;
}

interface InvocationRow {
  command_id: string;
  agent_id: string;
  grant_id: string | null;
  status: string;
  receipt_id: string | null;
}

function commitOf(row: InvocationCommitRow): ReplicaInvocationCommit {
  return {
    invocationId: row.invocation_id,
    commandId: row.command_id,
    ...(row.intent_id ? { intentId: row.intent_id } : {}),
    audit: JSON.parse(row.audit_json) as ReplicaInvocationAudit,
    committedAt: row.committed_at,
    ...(row.journal_finalized_at ? { journalFinalizedAt: row.journal_finalized_at } : {}),
  };
}

/** Read the vault-side proof that an invocation's canonical transaction committed. */
export function readReplicaInvocationCommit(
  vault: DatabaseSync,
  invocationId: string,
): ReplicaInvocationCommit | undefined {
  const row = vault
    .prepare(
      `SELECT invocation_id, command_id, intent_id, audit_json,
              committed_at, journal_finalized_at
         FROM replica_invocation_commit
        WHERE invocation_id = ?`,
    )
    .get(invocationId) as InvocationCommitRow | undefined;
  return row ? commitOf(row) : undefined;
}

/**
 * Record a successful canonical invocation inside the caller's open vault.db
 * transaction. Never wrap this in its own transaction: atomicity with the
 * command's ontology writes is the entire contract of this marker.
 */
export function recordReplicaInvocationCommitInTransaction(
  vault: DatabaseSync,
  input: RecordReplicaInvocationCommitInput,
): ReplicaInvocationCommit {
  if (!input.invocationId || !input.commandId || !input.committedAt) {
    throw new Error('replica invocation commit fields must be non-empty');
  }
  validateAudit(input.audit);
  const auditJson = JSON.stringify(input.audit);
  if (auditJson === undefined) {
    throw new Error('replica invocation commit metadata must be JSON-serializable');
  }
  vault
    .prepare(
      `INSERT INTO replica_invocation_commit (
         invocation_id, command_id, intent_id, audit_json,
         committed_at, journal_finalized_at
       ) VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(input.invocationId, input.commandId, input.intentId ?? null, auditJson, input.committedAt);
  const committed = readReplicaInvocationCommit(vault, input.invocationId);
  if (!committed) {
    throw new Error(`replica invocation ${input.invocationId} disappeared while recording`);
  }
  return committed;
}

export interface FinalizedInvocationJournal {
  receiptId: string;
  changed: boolean;
}

/**
 * Finish (or verify) every mandatory post-commit audit row in one journal.db
 * transaction. Existing prefix rows from an older partial attempt are reused;
 * conflicting rows fail closed. Invocation status changes to `executed` only
 * in the same commit that makes checks/provenance/receipt/evidence/explanation
 * complete.
 */
export function finalizeInvocationJournal(
  db: InvocationDatabases,
  invocationId: string,
  commandId: string,
  audit: ReplicaInvocationAudit,
  executedAt = nowIso(),
): FinalizedInvocationJournal {
  validateAudit(audit);
  let began = false;
  let changed = false;
  try {
    db.journal.exec('BEGIN IMMEDIATE');
    began = true;
    const invocation = db.journal
      .prepare(
        `SELECT command_id, agent_id, grant_id, status, receipt_id
           FROM agent_command_invocation WHERE invocation_id = ?`,
      )
      .get(invocationId) as InvocationRow | undefined;
    if (!invocation) throw new Error(`journal invocation ${invocationId} is missing`);
    if (
      invocation.command_id !== commandId ||
      invocation.agent_id !== audit.agentId ||
      invocation.grant_id !== audit.grantId
    ) {
      throw new Error(`journal invocation ${invocationId} conflicts with its canonical marker`);
    }
    if (['failed', 'rolled_back'].includes(invocation.status)) {
      throw new Error(`journal invocation ${invocationId} is already ${invocation.status}`);
    }

    changed = ensurePostChecks(db.journal, invocationId, audit.postChecks) || changed;
    changed = ensureProvenance(db.journal, invocationId, audit) || changed;
    const receipt = ensureReceipt(db.journal, invocationId, commandId, audit);
    changed = receipt.changed || changed;
    changed = ensureEvidence(db.journal, invocationId, audit.citations) || changed;
    changed = ensureExplanation(db.journal, invocationId, audit, receipt.receiptId) || changed;

    if (invocation.status !== 'executed' || invocation.receipt_id !== receipt.receiptId) {
      db.journal
        .prepare(
          `UPDATE agent_command_invocation
              SET status = 'executed', executed_at = ?, receipt_id = ?
            WHERE invocation_id = ?`,
        )
        .run(executedAt, receipt.receiptId, invocationId);
      changed = true;
    }
    assertAuditComplete(db.journal, invocationId, audit, receipt.receiptId);
    db.journal.exec('COMMIT');
    began = false;
    return { receiptId: receipt.receiptId, changed };
  } catch (error) {
    if (began) db.journal.exec('ROLLBACK');
    throw error;
  }
}

/** Repair one canonical marker and stamp proof only after journal verification. */
export function finalizeReplicaInvocationCommit(
  db: InvocationDatabases,
  invocationId: string,
): FinalizedInvocationJournal & { commit: ReplicaInvocationCommit } {
  const commit = readReplicaInvocationCommit(db.vault, invocationId);
  if (!commit) throw new Error(`replica invocation commit ${invocationId} is missing`);
  const finalized = finalizeInvocationJournal(
    db,
    invocationId,
    commit.commandId,
    commit.audit,
    commit.committedAt,
  );

  // This second database write is intentionally after the atomic journal
  // commit. A crash before it merely causes the next replay to verify again;
  // it can never falsely claim the audit was repaired.
  db.vault.exec('BEGIN IMMEDIATE');
  try {
    db.vault
      .prepare(
        `UPDATE replica_invocation_commit
            SET journal_finalized_at = COALESCE(journal_finalized_at, ?)
          WHERE invocation_id = ?`,
      )
      .run(nowIso(), invocationId);
    db.vault.exec('COMMIT');
  } catch (error) {
    db.vault.exec('ROLLBACK');
    throw error;
  }
  return {
    ...finalized,
    commit: readReplicaInvocationCommit(db.vault, invocationId) ?? commit,
  };
}

interface RepairCandidateRow {
  invocation_id: string;
  committed_at: string;
}

interface RepairCursor {
  committedAt: string;
  invocationId: string;
}

/**
 * Repair every crash-left canonical marker before a vault is served.
 *
 * Reads are keyset-paged in canonical `(committed_at, invocation_id)` order,
 * so memory and each SQLite result are bounded without allowing an early bad
 * marker to starve later provable ones. Each journal repair remains its own
 * atomic transaction. A failed marker is retained, the sweep continues, and
 * the caller ultimately receives a fail-closed error while any candidate is
 * still unfinished.
 */
export function repairReplicaInvocationCommits(
  db: InvocationDatabases,
  options: { batchSize?: number } = {},
): ReplicaInvocationRepairResult {
  const batchSize = options.batchSize ?? DEFAULT_REPLICA_INVOCATION_REPAIR_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_REPLICA_INVOCATION_REPAIR_BATCH_SIZE
  ) {
    throw new RangeError('replica invocation repair batch size must be between 1 and 5000');
  }

  const result: ReplicaInvocationRepairResult = {
    scanned: 0,
    finalized: 0,
    reclaimed: 0,
    retained: 0,
    remaining: 0,
    failures: [],
  };
  let cursor: RepairCursor | undefined;

  for (;;) {
    const rows = listRepairCandidates(db.vault, batchSize, cursor);
    if (rows.length === 0) break;

    for (const row of rows) {
      result.scanned += 1;
      try {
        const before = readReplicaInvocationCommit(db.vault, row.invocation_id);
        if (!before) continue;
        if (!before.journalFinalizedAt) {
          finalizeReplicaInvocationCommit(db, row.invocation_id);
          result.finalized += 1;
        }
        const reclaimed = reclaimFinalizedReplicaInvocationCommit(db.vault, row.invocation_id);
        result.reclaimed += reclaimed;
        if (reclaimed === 0) result.retained += 1;
      } catch (error) {
        result.failures.push({
          invocationId: row.invocation_id,
          reason: repairFailureReason(error),
        });
      }
    }

    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = { committedAt: last.committed_at, invocationId: last.invocation_id };
    if (rows.length < batchSize) break;
  }

  // A second process should not write during vault open, but this final
  // invariant also catches a marker inserted behind the keyset cursor. Never
  // serve while such a journal gap remains.
  result.remaining = countRepairCandidates(db.vault);
  if (result.remaining > 0) throw new ReplicaInvocationRepairError(result);
  return result;
}

function repairCandidatePredicate(): string {
  return `(
    journal_finalized_at IS NULL
    OR (
      journal_finalized_at IS NOT NULL
      AND (
        intent_id IS NULL
        OR intent_id IN (
          SELECT intent_id
            FROM replica_intent_outcome
           WHERE status IN ('executed', 'denied', 'failed')
        )
      )
    )
  )`;
}

function listRepairCandidates(
  vault: DatabaseSync,
  limit: number,
  cursor?: RepairCursor,
): RepairCandidateRow[] {
  const predicate = repairCandidatePredicate();
  const sql = cursor
    ? `SELECT invocation_id, committed_at
         FROM replica_invocation_commit
        WHERE ${predicate}
          AND (committed_at > ? OR (committed_at = ? AND invocation_id > ?))
        ORDER BY committed_at, invocation_id
        LIMIT ?`
    : `SELECT invocation_id, committed_at
         FROM replica_invocation_commit
        WHERE ${predicate}
        ORDER BY committed_at, invocation_id
        LIMIT ?`;
  return (cursor
    ? vault.prepare(sql).all(cursor.committedAt, cursor.committedAt, cursor.invocationId, limit)
    : vault.prepare(sql).all(limit)) as unknown as RepairCandidateRow[];
}

function countRepairCandidates(vault: DatabaseSync): number {
  const row = vault
    .prepare(
      `SELECT count(*) AS n
         FROM replica_invocation_commit
        WHERE ${repairCandidatePredicate()}`,
    )
    .get() as { n: number };
  return row.n;
}

/** Reclaim only proof-stamped ordinary or terminal-intent markers. */
function reclaimFinalizedReplicaInvocationCommit(
  vault: DatabaseSync,
  invocationId: string,
): number {
  return Number(
    vault
      .prepare(
        `DELETE FROM replica_invocation_commit
          WHERE invocation_id = ?
            AND journal_finalized_at IS NOT NULL
            AND (
              intent_id IS NULL
              OR intent_id IN (
                SELECT intent_id
                  FROM replica_intent_outcome
                 WHERE status IN ('executed', 'denied', 'failed')
              )
            )`,
      )
      .run(invocationId).changes,
  );
}

function repairFailureReason(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return reason.length > 240 ? `${reason.slice(0, 237)}...` : reason;
}

function validateAudit(audit: ReplicaInvocationAudit): void {
  if (
    !audit ||
    !audit.commandName ||
    !audit.agentId ||
    !['owner', 'app', 'ai_agent'].includes(audit.agentKind) ||
    !Number.isSafeInteger(audit.preconditionCount) ||
    audit.preconditionCount < 0 ||
    !Array.isArray(audit.postChecks) ||
    !Array.isArray(audit.writes) ||
    !Array.isArray(audit.citations) ||
    !audit.provenance?.activity ||
    !audit.receiptDetail
  ) {
    throw new Error('replica invocation audit metadata is invalid');
  }
}

function ensurePostChecks(
  journal: DatabaseSync,
  invocationId: string,
  expected: ReplicaInvocationAuditCheck[],
): boolean {
  const rows = journal
    .prepare(
      `SELECT predicate, passed, observed_json FROM agent_invocation_check
        WHERE invocation_id = ? AND phase = 'post' ORDER BY check_id`,
    )
    .all(invocationId) as unknown as Array<{
    predicate: string;
    passed: number;
    observed_json: string | null;
  }>;
  const available = [...rows];
  let changed = false;
  for (const check of expected) {
    const index = available.findIndex(
      (row) =>
        row.predicate === check.predicate &&
        row.passed === (check.passed ? 1 : 0) &&
        sameJson(row.observed_json, check.observed),
    );
    if (index >= 0) {
      available.splice(index, 1);
      continue;
    }
    writeCheck(journal, invocationId, 'post', check.predicate, check.passed, check.observed);
    changed = true;
  }
  if (available.length > 0) {
    throw new Error(`journal invocation ${invocationId} has conflicting post-check rows`);
  }
  return changed;
}

function ensureProvenance(
  journal: DatabaseSync,
  invocationId: string,
  audit: ReplicaInvocationAudit,
): boolean {
  const rows = journal
    .prepare(
      `SELECT entity_type, entity_id, prov_activity, agent_kind, agent_id, used_json
         FROM consent_provenance
        WHERE json_extract(used_json, '$.invocation') = ?`,
    )
    .all(invocationId) as unknown as Array<{
    entity_type: string;
    entity_id: string;
    prov_activity: string;
    agent_kind: string;
    agent_id: string;
    used_json: string | null;
  }>;
  const available = [...rows];
  let changed = false;
  const identity: Identity = {
    kind:
      audit.agentKind === 'owner'
        ? 'owner-device'
        : audit.agentKind === 'ai_agent'
          ? 'agent'
          : 'app',
    callerId: audit.agentId,
    provAgentKind: audit.agentKind,
    partyId: null,
    mayAct: true,
  };
  for (const write of audit.writes) {
    const index = available.findIndex(
      (row) =>
        row.entity_type === write.entityType &&
        row.entity_id === write.entityId &&
        row.prov_activity === audit.provenance.activity &&
        row.agent_kind === audit.agentKind &&
        row.agent_id === audit.agentId &&
        sameJson(row.used_json, audit.provenance.used),
    );
    if (index >= 0) {
      available.splice(index, 1);
      continue;
    }
    writeProvenance(
      journal,
      identity,
      write.entityType,
      write.entityId,
      audit.provenance.activity,
      audit.provenance.used,
      audit.agentKind,
    );
    changed = true;
  }
  if (available.length > 0) {
    throw new Error(`journal invocation ${invocationId} has conflicting provenance rows`);
  }
  return changed;
}

function ensureReceipt(
  journal: DatabaseSync,
  invocationId: string,
  commandId: string,
  audit: ReplicaInvocationAudit,
): { receiptId: string; changed: boolean } {
  const rows = journal
    .prepare(
      `SELECT receipt_id, grant_id, action, object_type, object_id,
              purpose_concept_id, decision, detail_json
         FROM consent_receipt WHERE invocation_id = ?`,
    )
    .all(invocationId) as unknown as Array<{
    receipt_id: string;
    grant_id: string | null;
    action: string;
    object_type: string;
    object_id: string | null;
    purpose_concept_id: string | null;
    decision: string;
    detail_json: string | null;
  }>;
  if (rows.length > 1) throw new Error(`journal invocation ${invocationId} has many receipts`);
  const row = rows[0];
  if (row) {
    if (
      row.grant_id !== audit.grantId ||
      row.action !== `act ${audit.commandName}` ||
      row.object_type !== 'agent.command' ||
      row.object_id !== commandId ||
      row.purpose_concept_id !== audit.purpose ||
      row.decision !== 'allow' ||
      !sameJson(row.detail_json, audit.receiptDetail)
    ) {
      throw new Error(`journal invocation ${invocationId} has a conflicting receipt`);
    }
    return { receiptId: row.receipt_id, changed: false };
  }
  return {
    receiptId: writeReceipt(journal, {
      grantId: audit.grantId,
      invocationId,
      action: `act ${audit.commandName}`,
      objectType: 'agent.command',
      objectId: commandId,
      purpose: audit.purpose,
      decision: 'allow',
      detail: audit.receiptDetail,
    }),
    changed: true,
  };
}

function ensureEvidence(
  journal: DatabaseSync,
  invocationId: string,
  expected: ReplicaInvocationAuditCitation[],
): boolean {
  const rows = journal
    .prepare(
      `SELECT claim, entity_type, entity_id, weight
         FROM agent_evidence WHERE invocation_id = ? ORDER BY evidence_id`,
    )
    .all(invocationId) as unknown as Array<{
    claim: string;
    entity_type: string;
    entity_id: string;
    weight: number | null;
  }>;
  const available = [...rows];
  let changed = false;
  for (const citation of expected) {
    const index = available.findIndex(
      (row) =>
        row.claim === citation.claim &&
        row.entity_type === citation.entityType &&
        row.entity_id === citation.entityId &&
        row.weight === (citation.weight ?? null),
    );
    if (index >= 0) {
      available.splice(index, 1);
      continue;
    }
    writeEvidence(journal, invocationId, [citation]);
    changed = true;
  }
  if (available.length > 0) {
    throw new Error(`journal invocation ${invocationId} has conflicting evidence rows`);
  }
  return changed;
}

function explanationSummary(audit: ReplicaInvocationAudit, receiptId: string): string {
  return (
    `${audit.commandName}: ${audit.preconditionCount} precondition(s) held, ` +
    `${audit.writes.length} row(s) written, ${audit.citations.length} evidence citation(s). ` +
    `Receipt ${receiptId}.`
  );
}

function ensureExplanation(
  journal: DatabaseSync,
  invocationId: string,
  audit: ReplicaInvocationAudit,
  receiptId: string,
): boolean {
  const row = journal
    .prepare(`SELECT summary FROM agent_explanation WHERE invocation_id = ?`)
    .get(invocationId) as { summary: string } | undefined;
  const summary = explanationSummary(audit, receiptId);
  if (row) {
    if (row.summary !== summary) {
      throw new Error(`journal invocation ${invocationId} has a conflicting explanation`);
    }
    return false;
  }
  writeExplanation(journal, invocationId, summary);
  return true;
}

function assertAuditComplete(
  journal: DatabaseSync,
  invocationId: string,
  audit: ReplicaInvocationAudit,
  receiptId: string,
): void {
  const invocation = journal
    .prepare(`SELECT status, receipt_id FROM agent_command_invocation WHERE invocation_id = ?`)
    .get(invocationId) as { status: string; receipt_id: string | null } | undefined;
  const post = journal
    .prepare(
      `SELECT count(*) AS n FROM agent_invocation_check
        WHERE invocation_id = ? AND phase = 'post'`,
    )
    .get(invocationId) as { n: number };
  const provenance = journal
    .prepare(
      `SELECT count(*) AS n FROM consent_provenance
        WHERE json_extract(used_json, '$.invocation') = ?`,
    )
    .get(invocationId) as { n: number };
  const evidence = journal
    .prepare(`SELECT count(*) AS n FROM agent_evidence WHERE invocation_id = ?`)
    .get(invocationId) as { n: number };
  const explanations = journal
    .prepare(`SELECT count(*) AS n FROM agent_explanation WHERE invocation_id = ?`)
    .get(invocationId) as { n: number };
  if (
    invocation?.status !== 'executed' ||
    invocation.receipt_id !== receiptId ||
    post.n !== audit.postChecks.length ||
    provenance.n !== audit.writes.length ||
    evidence.n !== audit.citations.length ||
    explanations.n !== 1
  ) {
    throw new Error(`journal invocation ${invocationId} audit repair is incomplete`);
  }
}

function sameJson(raw: string | null, expected: unknown): boolean {
  if (raw === null) return expected === undefined || expected === null;
  try {
    return canonicalJson(JSON.parse(raw) as unknown) === canonicalJson(expected);
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}
