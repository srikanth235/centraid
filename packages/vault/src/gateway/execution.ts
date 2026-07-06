// S3 + S4 + S5 for one invocation whose consent already allowed: contract
// validation, precondition checks recorded before anything mutates, the ACID
// execution boundary with postcondition rollback, then the evidence trail.
// Split from gateway.ts only for file size; the Gateway is still the sole
// caller.

import type { DatabaseSync } from 'node:sqlite';
import type { VaultDb } from '../db.js';
import { nowIso, uuidv7 } from '../ids.js';
import { promoteStagedBlob } from '../blob/promote.js';
import { stagedInfoTx } from '../blob/staging.js';
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
import { SEED_DEMO_ACTIVITY } from '../schema/seed.js';
import {
  isSealedValue,
  redactCommandInput,
  scrubSealedText,
  sealAad,
  sealValue,
  sealedColumnsOf,
  sealedValuesForCommand,
  stampSealKeyFingerprint,
  unsealValue,
} from '../schema/sealed.js';
import type {
  Citation,
  CommandDefinition,
  ConditionSpec,
  HandlerCtx,
  Identity,
  InvokeOutcome,
  InvokeRequest,
} from './types.js';

/**
 * A registered command as the gateway executes it: the handler plus the
 * sealed-class declarations (issue #293) that never leave process memory —
 * `sealedInput` drives journal redaction, `unseals` gates `ctx.unseal`.
 */
export interface RegisteredCommand {
  handler: CommandDefinition['handler'];
  sealedInput: readonly string[];
  unseals: readonly string[];
  transcriptSensitive: boolean;
}

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
  'core.collection_entry': { pk: 'entry_id', refs: [['target_type', 'target_id']] },
  'knowledge.annotation': { pk: 'annotation_id', refs: [['target_type', 'target_id']] },
};

export function pkColumn(vault: DatabaseSync, physical: string): string {
  const rows = vault.prepare(`PRAGMA table_info(${JSON.stringify(physical)})`).all() as {
    name: string;
    pk: number;
  }[];
  return rows.find((r) => r.pk === 1)?.name ?? 'rowid';
}

/**
 * §10 S4 + issue #272: hard-deleting an entity end-dates every live link
 * touching it, in exactly one place — no delete command carries its own
 * sweep, and no projection ever sees a live link to a vanished row. Soft
 * deletes keep their links (the row remains; the card resolver reports it
 * as trashed). Swept link ids are appended to `writes` so S5 stamps
 * provenance for them like any other write. History is never rewritten:
 * the link row survives with `valid_to` set (rule R3).
 */
export function sweepDanglingLinks(
  vault: DatabaseSync,
  writes: { entityType: string; entityId: string }[],
  now: string,
): void {
  // Index over the handler's own writes only — the loop appends the swept
  // link ids to the same array, and those must not be re-scanned.
  const handlerWrites = writes.length;
  for (let i = 0; i < handlerWrites; i += 1) {
    const write = writes[i];
    if (!write || write.entityType === 'core.link') continue;
    const ref = resolveEntity(write.entityType, vault);
    if (!ref || ref.file !== 'vault') continue;
    const pk = pkColumn(vault, ref.physical);
    const live = vault
      .prepare(`SELECT 1 AS x FROM "${ref.physical}" WHERE "${pk}" = ?`)
      .get(write.entityId);
    if (live) continue;
    const dangling = vault
      .prepare(
        `SELECT link_id FROM core_link
          WHERE valid_to IS NULL
            AND ((from_type = ? AND from_id = ?) OR (to_type = ? AND to_id = ?))`,
      )
      .all(write.entityType, write.entityId, write.entityType, write.entityId) as {
      link_id: string;
    }[];
    for (const row of dangling) {
      vault.prepare('UPDATE core_link SET valid_to = ? WHERE link_id = ?').run(now, row.link_id);
      writes.push({ entityType: 'core.link', entityId: row.link_id });
    }
  }
}

/**
 * The seal sweep (issue #293): every command write passes this chokepoint,
 * so a plaintext secret in a sealed column becomes ciphertext BEFORE the
 * transaction may commit — even when the handler was careless. Values that
 * are already sealed (re-writes of untouched columns) pass through.
 */
export function sealWrites(db: VaultDb, writes: { entityType: string; entityId: string }[]): void {
  let sealedAny = false;
  for (const write of writes) {
    const cols = sealedColumnsOf(write.entityType, db.vault);
    if (cols.length === 0) continue;
    const ref = resolveEntity(write.entityType, db.vault);
    if (!ref || ref.file !== 'vault') continue;
    const pk = pkColumn(db.vault, ref.physical);
    const select = cols.map((c) => `"${c}"`).join(', ');
    const row = db.vault
      .prepare(`SELECT ${select} FROM "${ref.physical}" WHERE "${pk}" = ?`)
      .get(write.entityId) as Record<string, unknown> | undefined;
    if (!row) continue; // deleted within the same command
    for (const col of cols) {
      const value = row[col];
      if (typeof value !== 'string' || value.length === 0 || isSealedValue(value)) continue;
      db.vault
        .prepare(`UPDATE "${ref.physical}" SET "${col}" = ? WHERE "${pk}" = ?`)
        .run(
          sealValue(db.sealKey, sealAad(ref.physical, col, write.entityId), value),
          write.entityId,
        );
      sealedAny = true;
    }
  }
  // The moment this vault first holds a sealed cell, the key's fingerprint
  // is stamped into core_vault settings (issue #298 item 1) — inside the
  // same transaction, so "has secrets" and the secrets themselves commit
  // together. From here on, opening without the matching key fails loudly.
  if (sealedAny) stampSealKeyFingerprint(db.vault, db.sealKey);
}

/** Validate every polymorphic row this invocation wrote. Throws to roll back. */
export function validatePolymorphicWrites(
  vault: DatabaseSync,
  writes: { entityType: string; entityId: string }[],
): void {
  for (const write of writes) {
    const rule = POLY_RULES[write.entityType];
    if (!rule) continue;
    const table = resolveEntity(write.entityType, vault);
    if (!table) continue;
    const row = vault
      .prepare(`SELECT * FROM "${table.physical}" WHERE "${rule.pk}" = ?`)
      .get(write.entityId) as Record<string, unknown> | undefined;
    if (!row) continue; // deleted within the same command — nothing to point anywhere
    for (const [typeCol, idCol] of rule.refs) {
      const logical = String(row[typeCol]);
      const id = String(row[idCol]);
      const target = resolveEntity(logical, vault);
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
  sealedInput: readonly string[] = [],
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
      // The journal is append-only (issue #293): declared secret inputs land
      // as keyed hash tokens, never as values — a leak here is permanent.
      // Command-aware so the ext trio's nested secrets redact too (#298 item 9).
      JSON.stringify(
        redactCommandInput(db.sealKey, command.name, request.input, sealedInput, db.vault),
      ),
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
  commands: ReadonlyMap<string, RegisteredCommand>,
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
  const sealedInput = commands.get(command.name)?.sealedInput ?? [];
  // Error surfaces get the same discipline as input_json (issue #298 item
  // 7): any text derived from runtime values passes through the sealed
  // scrub before it reaches the journal, the receipt or the HTTP response.
  // Command-aware so the ext trio's nested secrets scrub too (#298 item 9).
  const secretValues = sealedValuesForCommand(command.name, request.input, sealedInput, db.vault);
  const scrub = (text: string): string => scrubSealedText(db.sealKey, text, secretValues);
  const schemaErrors = validateJson(JSON.parse(command.input_schema_json), request.input).map(
    scrub,
  );
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
  const registered = commands.get(command.name);
  if (!registered) return denyContract('handler missing', { stage: 'execution' });
  const handler = registered.handler;
  // Cells this command decrypted internally (issue #293) — receipted as
  // column names, never values.
  const unsealed = new Set<string>();
  const ctx: HandlerCtx = {
    db: db.vault,
    identity,
    input: request.input,
    purpose: request.purpose,
    now: nowIso(),
    newId: uuidv7,
    wrote: (entityType, entityId) => writes.push({ entityType, entityId }),
    cite: (citation) => citations.push(citation),
    unseal: (entityType, entityId, column) => {
      const cell = `${entityType}.${column}`;
      if (!registered.unseals.includes(cell)) {
        throw new Error(`${command.name} does not declare unseal of ${cell}`);
      }
      const ref = resolveEntity(entityType, db.vault);
      if (!ref || ref.file !== 'vault') throw new Error(`unknown entity ${entityType}`);
      const pk = pkColumn(db.vault, ref.physical);
      const row = db.vault
        .prepare(`SELECT "${column}" AS v FROM "${ref.physical}" WHERE "${pk}" = ?`)
        .get(entityId) as { v: unknown } | undefined;
      if (!row || row.v == null) return null;
      unsealed.add(cell);
      const value = String(row.v);
      return isSealedValue(value)
        ? unsealValue(db.sealKey, sealAad(ref.physical, column, entityId), value)
        : value;
    },
    // Blob custody inside the transaction (issue #296): claims and spills
    // are row work — bytes already sit in (or synchronously enter) the
    // local CAS, so a rollback leaves the stage intact and orphans at
    // worst a content-addressed file the staging sweep reclaims.
    blobs: {
      staged: (sha256) => {
        const row = stagedInfoTx(db.vault, sha256);
        return row
          ? {
              mediaType: row.media_type,
              byteSize: row.byte_size,
              originalName: row.original_name,
              meta: JSON.parse(row.meta_json) as Record<string, unknown>,
            }
          : null;
      },
      claimStaged: (sha256, options) =>
        promoteStagedBlob(
          {
            vault: db.vault,
            now: nowIso(),
            newId: uuidv7,
            wrote: (entityType, entityId) => writes.push({ entityType, entityId }),
            creatorPartyId: identity.partyId,
          },
          sha256,
          options,
        ),
      spill: (bytes) => db.blobs.ingestSync(bytes).sha256,
      has: (sha256) => db.blobs.hasSync(sha256),
    },
  };
  let output: Record<string, unknown>;
  db.vault.exec('BEGIN');
  try {
    output = handler(ctx);
    // §10 S4: polymorphic refs validated before the transaction may commit.
    validatePolymorphicWrites(db.vault, writes);
    // Then the temporal lifecycle duty: rows this command hard-deleted
    // end-date their inbound/outbound links (after validation — a swept
    // link points at the deleted row by design).
    sweepDanglingLinks(db.vault, writes, ctx.now);
    // The seal sweep (issue #293): plaintext in sealed columns becomes
    // ciphertext inside the same transaction — no committed row ever holds a
    // clear secret, however the handler wrote it.
    sealWrites(db, writes);
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
    // Demo-register writes join the seed registry INSIDE the transaction —
    // a committed demo row that escaped the registry would be unpurgeable
    // and visible to triggers (issue #290 phase 1).
    if (request.demo) {
      const seedStmt = db.vault.prepare(
        `INSERT INTO consent_seed_row (seed_id, app_id, entity_type, entity_id, seeded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (entity_type, entity_id) DO NOTHING`,
      );
      for (const write of writes) {
        seedStmt.run(uuidv7(), request.demo.appId, write.entityType, write.entityId, ctx.now);
      }
    }
    db.vault.exec('COMMIT');
    for (const r of postResults)
      writeCheck(db.journal, invocationId, 'post', r.predicate, r.passed, r.observed);
  } catch (err) {
    db.vault.exec('ROLLBACK');
    setInvocationStatus(db, invocationId, 'failed');
    // A handler (or SQLite constraint message) that echoes its input would
    // put a submitted secret into the journal and the HTTP error — scrub
    // declared sealed inputs out of the text first (issue #298 item 7).
    const reason = scrub(err instanceof Error ? err.message : String(err));
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
  // Demo-register writes stamp `seed.demo` — the journal-side truth that a
  // row is scenario data; the command still names itself in `used_json`.
  for (const write of writes) {
    writeProvenance(
      db.journal,
      identity,
      write.entityType,
      write.entityId,
      request.demo ? SEED_DEMO_ACTIVITY : `command.${command.name}`,
      request.demo
        ? { invocation: invocationId, command: command.name, app: request.demo.appId }
        : { invocation: invocationId },
    );
  }
  // A transcript-sensitive command's output is secret-derived (issue #298
  // item 6): the caller still gets the live value below, but it must NOT
  // persist in the journal receipt (a durable store, read back on replay).
  const receiptOutput = registered.transcriptSensitive
    ? { redacted: 'transcript-sensitive derivative (issue #298 item 6)' }
    : output;
  const receiptId = writeReceipt(db.journal, {
    grantId: consent.grantId,
    invocationId,
    action: `act ${command.name}`,
    objectType: 'agent.command',
    objectId: command.command_id,
    purpose: request.purpose,
    decision: 'allow',
    detail: {
      output: receiptOutput,
      writes,
      ...(unsealed.size > 0 ? { unsealed: [...unsealed] } : {}),
      ...(confirmation ? { confirmation } : {}),
    },
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
