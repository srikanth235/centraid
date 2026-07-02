// S3 + S4 + S5 for one invocation whose consent already allowed: contract
// validation, precondition checks recorded before anything mutates, the ACID
// execution boundary with postcondition rollback, then the evidence trail.
// Split from gateway.ts only for file size; the Gateway is still the sole
// caller.

import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { nowIso, uuidv7 } from '../ids.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import { resolveEntity } from '../schema/tables.js';
import type { ConsentAllow } from './consent.js';
import { evaluateConditions, judgmentVeto, type CommandRow } from './contract.js';
import {
  writeCheck,
  writeEvidence,
  writeExplanation,
  writeProvenance,
  writeReceipt,
} from './evidence.js';
import { validateJson } from './json-schema.js';
import type {
  Citation,
  CommandDefinition,
  ConditionSpec,
  HandlerCtx,
  Identity,
  InvokeOutcome,
  InvokeRequest,
} from './types.js';

// §10 S4: polymorphic (type, id) pairs that declarative FKs cannot express.
// Any row a command writes into these tables must point at live rows, or the
// whole invocation rolls back.
const POLY_RULES: Record<string, { pk: string; refs: [string, string][] }> = {
  'core.link': {
    pk: 'link_id',
    refs: [
      ['from_type', 'from_id'],
      ['to_type', 'to_id'],
    ],
  },
  'core.attachment': { pk: 'attachment_id', refs: [['subject_type', 'subject_id']] },
  'core.tag': { pk: 'tag_id', refs: [['target_type', 'target_id']] },
  'knowledge.annotation': { pk: 'annotation_id', refs: [['target_type', 'target_id']] },
};

function pkColumn(vault: DatabaseSync, physical: string): string {
  const rows = vault.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
    name: string;
    pk: number;
  }[];
  return rows.find((r) => r.pk === 1)?.name ?? 'rowid';
}

/** Validate every polymorphic row this invocation wrote. Throws to roll back. */
export function validatePolymorphicWrites(
  vault: DatabaseSync,
  writes: { entityType: string; entityId: string }[],
): void {
  for (const write of writes) {
    const rule = POLY_RULES[write.entityType];
    if (!rule) continue;
    const table = resolveEntity(write.entityType);
    if (!table) continue;
    const row = vault
      .prepare(`SELECT * FROM "${table.physical}" WHERE "${rule.pk}" = ?`)
      .get(write.entityId) as Record<string, unknown> | undefined;
    if (!row) continue; // deleted within the same command — nothing to point anywhere
    for (const [typeCol, idCol] of rule.refs) {
      const logical = String(row[typeCol]);
      const id = String(row[idCol]);
      const target = resolveEntity(logical);
      if (!target || target.file !== 'vault') {
        throw new Error(`${write.entityType}.${typeCol} names unknown entity "${logical}"`);
      }
      const pk = pkColumn(vault, target.physical);
      const live = vault
        .prepare(`SELECT 1 AS x FROM "${target.physical}" WHERE "${pk}" = ?`)
        .get(id);
      if (!live) {
        throw new Error(
          `${write.entityType} ${write.entityId}: (${logical}, ${id}) does not resolve to a live row`,
        );
      }
    }
  }
}

export function insertInvocation(
  db: VaultDb,
  request: InvokeRequest,
  command: CommandRow,
  identity: Identity,
  grantId: string | null,
  status: string,
  fixedId?: string,
): string {
  const invocationId = fixedId ?? request.invocationId ?? uuidv7();
  db.journal
    .prepare(
      `INSERT INTO agent_command_invocation (invocation_id, command_id, agent_id, grant_id, input_json, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      invocationId,
      command.command_id,
      identity.callerId,
      grantId,
      JSON.stringify(request.input),
      status,
      nowIso(),
    );
  return invocationId;
}

export function invocationExists(db: VaultDb, invocationId: string): boolean {
  return (
    db.journal
      .prepare('SELECT 1 AS x FROM agent_command_invocation WHERE invocation_id = ?')
      .get(invocationId) !== undefined
  );
}

export function setInvocationStatus(db: VaultDb, invocationId: string, status: string): void {
  db.journal
    .prepare('UPDATE agent_command_invocation SET status = ? WHERE invocation_id = ?')
    .run(status, invocationId);
}

/** Idempotent replay (§10 S4): a re-sent invocation id never double-writes. */
export function replayInvocation(db: VaultDb, invocationId: string): InvokeOutcome | null {
  const row = db.journal
    .prepare('SELECT status, receipt_id FROM agent_command_invocation WHERE invocation_id = ?')
    .get(invocationId) as { status: string; receipt_id: string | null } | undefined;
  if (!row || row.status !== 'executed') return null;
  let output: unknown = null;
  if (row.receipt_id) {
    const receipt = db.journal
      .prepare('SELECT detail_json FROM consent_receipt WHERE receipt_id = ?')
      .get(row.receipt_id) as { detail_json: string | null } | undefined;
    if (receipt?.detail_json)
      output = (JSON.parse(receipt.detail_json) as { output?: unknown }).output ?? null;
  }
  return { status: 'replayed', invocationId, output };
}

export function runContractAndExecute(
  db: VaultDb,
  handlers: ReadonlyMap<string, CommandDefinition['handler']>,
  identity: Identity,
  request: InvokeRequest,
  command: CommandRow,
  consent: ConsentAllow,
  invocationId: string,
  confirmation?: Record<string, unknown>,
): InvokeOutcome {
  const denyContract = (predicate: string, detail: Record<string, unknown>): InvokeOutcome => {
    setInvocationStatus(db, invocationId, 'failed');
    const receiptId = writeReceipt(db.journal, {
      grantId: consent.grantId,
      invocationId,
      action: `act ${command.name}`,
      objectType: 'agent.command',
      objectId: command.command_id,
      purpose: request.purpose,
      decision: 'deny',
      detail,
    });
    writeExplanation(db.journal, invocationId, `${command.name} did not run: ${predicate}.`);
    return { status: 'failed', invocationId, receiptId, reason: predicate, predicate };
  };

  // Contract version negotiation (§10 S3, R07): this gateway serves exactly
  // one ontology version; compatibility windows for older contracts are a
  // seam. Refusing beats guessing.
  if (command.ontology_version !== ONTOLOGY_VERSION) {
    return denyContract(`contract version ${command.ontology_version} not served`, {
      stage: 'contract',
      commandVersion: command.ontology_version,
      gatewayVersion: ONTOLOGY_VERSION,
    });
  }
  const schemaErrors = validateJson(JSON.parse(command.input_schema_json), request.input);
  if (schemaErrors.length > 0) {
    return denyContract(`input schema violation`, { stage: 'contract', errors: schemaErrors });
  }
  const veto = judgmentVeto(db.vault, command.name, command.owner_schema);
  if (veto) {
    writeCheck(db.journal, invocationId, 'pre', `judgment:${veto}`, false);
    return denyContract(`vetoed by judgment ${veto}`, { stage: 'contract', judgment: veto });
  }
  const preSpecs = JSON.parse(command.preconditions_json) as ConditionSpec[];
  const preResults = evaluateConditions(db.vault, preSpecs, request.input);
  for (const result of preResults) {
    writeCheck(db.journal, invocationId, 'pre', result.predicate, result.passed, result.observed);
  }
  const failedPre = preResults.find((r) => !r.passed);
  if (failedPre) {
    return denyContract(failedPre.predicate, { stage: 'contract', predicate: failedPre.predicate });
  }
  setInvocationStatus(db, invocationId, 'checked');

  // S4 — execution: the only writer in the system.
  const writes: { entityType: string; entityId: string }[] = [];
  const citations: Citation[] = [];
  const handler = handlers.get(command.name);
  if (!handler) return denyContract('handler missing', { stage: 'execution' });
  const ctx: HandlerCtx = {
    db: db.vault,
    identity,
    input: request.input,
    now: nowIso(),
    newId: uuidv7,
    wrote: (entityType, entityId) => writes.push({ entityType, entityId }),
    cite: (citation) => citations.push(citation),
  };
  let output: Record<string, unknown>;
  db.vault.exec('BEGIN');
  try {
    output = handler(ctx);
    // §10 S4: polymorphic refs validated before the transaction may commit.
    validatePolymorphicWrites(db.vault, writes);
    const postSpecs = JSON.parse(command.postconditions_json) as ConditionSpec[];
    const postResults = evaluateConditions(db.vault, postSpecs, { ...request.input, ...output });
    const failedPost = postResults.find((r) => !r.passed);
    if (failedPost) {
      db.vault.exec('ROLLBACK');
      for (const r of postResults)
        writeCheck(db.journal, invocationId, 'post', r.predicate, r.passed, r.observed);
      setInvocationStatus(db, invocationId, 'rolled_back');
      const receiptId = writeReceipt(db.journal, {
        grantId: consent.grantId,
        invocationId,
        action: `act ${command.name}`,
        objectType: 'agent.command',
        objectId: command.command_id,
        purpose: request.purpose,
        decision: 'deny',
        detail: { stage: 'execution', predicate: failedPost.predicate },
      });
      writeExplanation(
        db.journal,
        invocationId,
        `${command.name} rolled back: ${failedPost.predicate}.`,
      );
      return {
        status: 'failed',
        invocationId,
        receiptId,
        reason: failedPost.predicate,
        predicate: failedPost.predicate,
      };
    }
    db.vault.exec('COMMIT');
    for (const r of postResults)
      writeCheck(db.journal, invocationId, 'post', r.predicate, r.passed, r.observed);
  } catch (err) {
    db.vault.exec('ROLLBACK');
    setInvocationStatus(db, invocationId, 'failed');
    const reason = err instanceof Error ? err.message : String(err);
    const receiptId = writeReceipt(db.journal, {
      grantId: consent.grantId,
      invocationId,
      action: `act ${command.name}`,
      objectType: 'agent.command',
      objectId: command.command_id,
      purpose: request.purpose,
      decision: 'deny',
      detail: { stage: 'execution', error: reason },
    });
    writeExplanation(
      db.journal,
      invocationId,
      `${command.name} failed during execution: ${reason}.`,
    );
    return { status: 'failed', invocationId, receiptId, reason };
  }

  // S5 — evidence: provenance per write, receipt, evidence, explanation.
  for (const write of writes) {
    writeProvenance(
      db.journal,
      identity,
      write.entityType,
      write.entityId,
      `command.${command.name}`,
      {
        invocation: invocationId,
      },
    );
  }
  const receiptId = writeReceipt(db.journal, {
    grantId: consent.grantId,
    invocationId,
    action: `act ${command.name}`,
    objectType: 'agent.command',
    objectId: command.command_id,
    purpose: request.purpose,
    decision: 'allow',
    detail: { output, writes, ...(confirmation ? { confirmation } : {}) },
  });
  writeEvidence(db.journal, invocationId, citations);
  writeExplanation(
    db.journal,
    invocationId,
    `${command.name}: ${preResults.length} precondition(s) held, ` +
      `${writes.length} row(s) written, ${citations.length} evidence citation(s). Receipt ${receiptId}.`,
  );
  db.journal
    .prepare(
      `UPDATE agent_command_invocation SET status='executed', executed_at=?, receipt_id=? WHERE invocation_id=?`,
    )
    .run(nowIso(), receiptId, invocationId);
  return { status: 'executed', invocationId, receiptId, output };
}
