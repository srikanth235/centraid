// governance: allow-repo-hygiene file-size-limit S3+S4+S5 of one invocation — contract / precondition / ACID boundary / evidence are one non-splittable transaction bracket, already carved from gateway.ts
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
import { writeCheck, writeExplanation, writeReceipt } from './evidence.js';
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
import { DEFAULT_PURPOSE, GatewayError } from './types.js';
import { readDurableParkedDenial, readDurableParkedPayload } from '../replica/parked.js';
import {
  finalizeReplicaInvocationCommit,
  readReplicaInvocationCommit,
  recordReplicaInvocationCommitInTransaction,
  type ReplicaInvocationAudit,
} from '../replica/invocation-commits.js';

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
  'core.attachment': { pk: 'attachment_id', refs: [['target_type', 'target_id']] },
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

/**
 * Bind a caller-supplied idempotency key to the immutable journal identity
 * before a handler can run. Canonical commit repair repeats this check after
 * COMMIT, but that is deliberately only a corruption guard: discovering a
 * conflicting reuse there would leave an unaudited canonical write behind.
 */
export function assertInvocationIdentity(
  db: VaultDb,
  invocationId: string,
  commandId: string,
  agentId: string,
  grantId: string | null,
): boolean {
  const existing = db.journal
    .prepare(
      `SELECT command_id, agent_id, grant_id
         FROM agent_command_invocation
        WHERE invocation_id = ?`,
    )
    .get(invocationId) as
    | { command_id: string; agent_id: string; grant_id: string | null }
    | undefined;
  if (!existing) return false;
  if (
    existing.command_id !== commandId ||
    existing.agent_id !== agentId ||
    existing.grant_id !== grantId
  ) {
    throw new GatewayError(
      'contract',
      `invocation id ${invocationId} is already bound to another command, caller, or grant`,
    );
  }
  return true;
}

export function setInvocationStatus(db: VaultDb, invocationId: string, status: string): void {
  db.journal
    .prepare('UPDATE agent_command_invocation SET status = ? WHERE invocation_id = ?')
    .run(status, invocationId);
}

/** Recursively scrub sealed values before crash-repair metadata becomes durable. */
function scrubAuditValue(value: unknown, scrub: (text: string) => string): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubAuditValue(item, scrub));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        scrubAuditValue(item, scrub),
      ]),
    );
  }
  return value;
}

/** Recover the ordinary online replay value from its allow receipt. */
function receiptOutput(journal: DatabaseSync, receiptId: string | null): unknown {
  if (!receiptId) return null;
  const receipt = journal
    .prepare('SELECT detail_json FROM consent_receipt WHERE receipt_id = ?')
    .get(receiptId) as { detail_json: string | null } | undefined;
  if (!receipt?.detail_json) return null;
  return (JSON.parse(receipt.detail_json) as { output?: unknown }).output ?? null;
}

/** Idempotent replay (§10 S4): a re-sent invocation id never double-writes. */
export function replayInvocation(db: VaultDb, invocationId: string): InvokeOutcome | null {
  const denied = readDurableParkedDenial(db, invocationId);
  if (denied) return { status: 'denied', ...denied };
  // Canonical commit proof takes precedence over journal status. It carries
  // the S5 material needed to atomically repair a crash-left audit prefix
  // before replay is allowed to return. Replica markers omit output, while
  // ordinary online invocations preserve their established receipt replay.
  const committed = readReplicaInvocationCommit(db.vault, invocationId);
  if (committed) {
    const finalized = finalizeReplicaInvocationCommit(db, invocationId);
    const output = receiptOutput(db.journal, finalized.receiptId);
    if (!committed.intentId) {
      db.vault
        .prepare(
          `DELETE FROM replica_invocation_commit
            WHERE invocation_id = ? AND journal_finalized_at IS NOT NULL`,
        )
        .run(invocationId);
    }
    return {
      status: 'replayed',
      invocationId,
      output,
    };
  }
  const row = db.journal
    .prepare('SELECT status, receipt_id FROM agent_command_invocation WHERE invocation_id = ?')
    .get(invocationId) as { status: string; receipt_id: string | null } | undefined;
  if (row?.status === 'executed') {
    return { status: 'replayed', invocationId, output: receiptOutput(db.journal, row.receipt_id) };
  }
  if (row && (row.status === 'failed' || row.status === 'rolled_back')) {
    const receipt = db.journal
      .prepare(
        `SELECT receipt_id, detail_json
           FROM consent_receipt
          WHERE invocation_id = ? AND decision = 'deny'
          ORDER BY occurred_at DESC, receipt_id DESC
          LIMIT 1`,
      )
      .get(invocationId) as { receipt_id: string; detail_json: string | null } | undefined;
    if (receipt) {
      const detail = receipt.detail_json
        ? (JSON.parse(receipt.detail_json) as {
            failing?: unknown;
            error?: unknown;
            predicate?: unknown;
          })
        : {};
      const reason = [detail.failing, detail.error, detail.predicate].find(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      return {
        status: 'failed',
        invocationId,
        receiptId: receipt.receipt_id,
        reason: reason ?? `invocation ${row.status}`,
      };
    }
  }
  if (row) {
    const parked = readDurableParkedPayload(db, invocationId);
    return parked ? { status: 'parked', invocationId, reason: parked.reason } : null;
  }
  return null;
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
  onProvenanceCommitted?: (entityTypes: readonly string[]) => void,
): InvokeOutcome {
  // The purpose that applies (issue #306 decision 4) — journaled even when
  // the caller declared none.
  const purpose = request.purpose ?? DEFAULT_PURPOSE;
  const denyContract = (predicate: string, detail: Record<string, unknown>): InvokeOutcome => {
    setInvocationStatus(db, invocationId, 'failed');
    const receiptId = writeReceipt(db.journal, {
      grantId: consent.grantId,
      invocationId,
      action: `act ${command.name}`,
      objectType: 'agent.command',
      objectId: command.command_id,
      purpose,
      decision: 'deny',
      detail: { ...detail, risk: command.risk },
    });
    writeExplanation(db.journal, invocationId, `${command.name} did not run: ${predicate}.`);
    return { status: 'failed', invocationId, receiptId, reason: predicate, predicate };
  };

  // Contract version negotiation (§10 S3, R07): this gateway serves exactly
  // one ontology version; compatibility windows for older contracts are a
  // seam. Refusing beats guessing.
  // v0 stance (issue #310 C5): version compatibility is EQUALITY, on
  // purpose — there is no data to migrate and no third-party apps to keep
  // rendering, so a mismatch means a stale registration, not a client on an
  // old contract. R07's compatibility windows (serving version ranges
  // during migrations) return when v1 ships and the doc's promise becomes
  // load-bearing.
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
    // `denyContract`'s argument becomes outcome.reason/predicate — the
    // app-facing surface — so prefer the command author's own sentence
    // there; the raw `name: column op value` string still goes into the
    // receipt detail and the checks-table audit trail via writeCheck above.
    return denyContract(failedPre.message ?? failedPre.predicate, {
      stage: 'contract',
      predicate: failedPre.predicate,
    });
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
    purpose,
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
  let output!: Record<string, unknown>;
  let audit!: ReplicaInvocationAudit;
  let postResults: ReturnType<typeof evaluateConditions> = [];
  let vaultTransactionOpen = false;
  db.vault.exec('BEGIN');
  vaultTransactionOpen = true;
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
    postResults = evaluateConditions(db.vault, postSpecs, { ...request.input, ...output });
    const failedPost = postResults.find((r) => !r.passed);
    if (failedPost) {
      db.vault.exec('ROLLBACK');
      vaultTransactionOpen = false;
      for (const r of postResults)
        writeCheck(db.journal, invocationId, 'post', r.predicate, r.passed, r.observed);
      setInvocationStatus(db, invocationId, 'rolled_back');
      // Same split as the precondition path above: friendly-or-raw for the
      // app-facing reason/predicate, raw always in the receipt detail.
      const friendly = failedPost.message ?? failedPost.predicate;
      const receiptId = writeReceipt(db.journal, {
        grantId: consent.grantId,
        invocationId,
        action: `act ${command.name}`,
        objectType: 'agent.command',
        objectId: command.command_id,
        purpose,
        decision: 'deny',
        detail: { stage: 'execution', predicate: failedPost.predicate, risk: command.risk },
      });
      writeExplanation(db.journal, invocationId, `${command.name} rolled back: ${friendly}.`);
      return {
        status: 'failed',
        invocationId,
        receiptId,
        reason: friendly,
        predicate: friendly,
      };
    }
    // Demo-register writes join the seed registry INSIDE the transaction —
    // a committed demo row that escaped the registry would be unpurgeable
    // and visible to triggers (issue #290 phase 1).
    if (request.demo) {
      const seedStmt = db.vault.prepare(
        `INSERT INTO consent_seed_row (seed_id, app_id, target_type, target_id, seeded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (target_type, target_id) DO NOTHING`,
      );
      for (const write of writes) {
        seedStmt.run(uuidv7(), request.demo.appId, write.entityType, write.entityId, ctx.now);
      }
    }

    const provenance = {
      activity: request.demo ? SEED_DEMO_ACTIVITY : `command.${command.name}`,
      used: request.demo
        ? { invocation: invocationId, command: command.name, app: request.demo.appId }
        : { invocation: invocationId },
    };
    // Existing online idempotent replay reads output back from the receipt.
    // Transcript-sensitive commands persist only the established redaction.
    // Replica intents deliberately omit the field from both their marker and
    // receipt; their caller reconciles canonical rows and replay returns null.
    const durableOutput = registered.transcriptSensitive
      ? { redacted: 'transcript-sensitive derivative (issue #298 item 6)' }
      : output;
    audit = {
      commandName: command.name,
      agentId: identity.callerId,
      agentKind: identity.provAgentKind,
      grantId: consent.grantId,
      purpose,
      preconditionCount: preResults.length,
      postChecks: postResults.map((result) => ({
        predicate: result.predicate,
        passed: result.passed,
        observed: scrubAuditValue(result.observed, scrub) as Record<string, unknown>,
      })),
      writes: writes.map((write) => ({ ...write })),
      citations: citations.map((citation) => ({ ...citation })),
      provenance,
      receiptDetail: {
        ...(!request.intentId ? { output: durableOutput } : {}),
        writes: writes.map((write) => ({ ...write })),
        // The salience marker (issue #306 decision 2): what the review feed
        // surfaces first, now that risk no longer gates execution.
        risk: command.risk,
        ...(unsealed.size > 0 ? { unsealed: [...unsealed] } : {}),
        ...(confirmation ? { confirmation } : {}),
      },
    };

    // The marker is part of every canonical transaction, not only replica
    // intents. Replica intents retain it until their durable outcome is
    // terminal; ordinary invocations reclaim it after journal proof below.
    recordReplicaInvocationCommitInTransaction(db.vault, {
      invocationId,
      commandId: command.command_id,
      ...(request.intentId ? { intentId: request.intentId } : {}),
      audit,
      committedAt: ctx.now,
    });
    db.vault.exec('COMMIT');
    vaultTransactionOpen = false;
  } catch (err) {
    if (vaultTransactionOpen) db.vault.exec('ROLLBACK');
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
      purpose,
      decision: 'deny',
      detail: { stage: 'execution', error: reason, risk: command.risk },
    });
    writeExplanation(
      db.journal,
      invocationId,
      `${command.name} failed during execution: ${reason}.`,
    );
    return { status: 'failed', invocationId, receiptId, reason };
  }

  // Everything after the canonical COMMIT is one idempotent journal
  // transaction. If it aborts, the marker survives and replay repairs it
  // before returning; the command handler is never re-entered.
  const finalized = finalizeReplicaInvocationCommit(db, invocationId);
  // The doorbell is strictly post-journal-commit: `finalizeReplicaInvocationCommit`
  // has made every provenance row readable on journal.db before the hint can
  // ask a data-trigger cursor to look. It is intentionally best-effort — a
  // thrown host callback must never turn a committed vault write into an
  // apparent failure; the cron poll remains the correctness backstop.
  try {
    onProvenanceCommitted?.([...new Set(writes.map((write) => write.entityType))]);
  } catch {
    // Hint only; the persisted cursor and poll backstop own correctness.
  }
  if (!request.intentId) {
    db.vault
      .prepare(
        `DELETE FROM replica_invocation_commit
          WHERE invocation_id = ? AND journal_finalized_at IS NOT NULL`,
      )
      .run(invocationId);
  }
  return { status: 'executed', invocationId, receiptId: finalized.receiptId, output };
}
