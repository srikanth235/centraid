// governance: allow-repo-hygiene file-size-limit S3+S4+S5 of one invocation — contract, precondition, ACID boundary and evidence are one transaction bracket
// S3 + S4 + S5 for one already-consented invocation: contract, preconditions
// recorded before anything mutates, the ACID boundary with postcondition
// rollback, then evidence.

import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { promoteStagedBlob } from "../blob/promote.js";
import { stagedInfoTx } from "../blob/staging.js";
import type { VaultDb } from "../db.js";
import { nowIso, uuidv7 } from "../ids.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { notifyReplicaCommit } from "../replica/doorbell.js";
import {
  finalizeReplicaInvocationCommit,
  finalizeOrdinaryInvocationCommit,
  readReplicaInvocationCommit,
  recordReplicaInvocationCommitInTransaction,
} from "../replica/invocation-commits.js";
import type { ReplicaInvocationAudit } from "../replica/invocation-commits.js";
import {
  readDurableParkedDenial,
  readDurableParkedPayload,
} from "../replica/parked.js";
import { ONTOLOGY_VERSION } from "../schema/migrate.js";
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
} from "../schema/sealed.js";
import { SEED_DEMO_ACTIVITY } from "../schema/seed.js";
import { resolveEntity } from "../schema/tables.js";
import type { AccessAllow } from "./access.js";
import { evaluateConditions } from "./contract.js";
import type { CommandRow } from "./contract.js";
import {
  actingOwnerDetail,
  writeCheck,
  writeExplanation,
  writeReceipt,
} from "./evidence.js";
import { validateJson } from "./json-schema.js";
import {
  closeRevisionCapture,
  drainRevisionCapture,
  openRevisionCapture,
} from "./revision-capture.js";
import type {
  Citation,
  CommandDefinition,
  ConditionSpec,
  HandlerCtx,
  HandlerReceipt,
  Identity,
  InvokeOutcome,
  InvokeRequest,
} from "./types.js";
import { DEFAULT_PURPOSE, GatewayError } from "./types.js";

/** `sealedInput` drives journal redaction, `unseals` gates `ctx.unseal` (#293). */
export interface RegisteredCommand {
  handler: CommandDefinition["handler"];
  sealedInput: readonly string[];
  unseals: readonly string[];
  transcriptSensitive: boolean;
  /** No pre-mutation snapshot: the point of the command is that it is gone. */
  erasure: boolean;
}

interface InvocationTransaction {
  savepoint: string | null;
  open: boolean;
}

function beginInvocationTransaction(db: DatabaseSync): InvocationTransaction {
  if (db.isTransaction) {
    db.exec("SAVEPOINT centraid_invocation");
    return { savepoint: "centraid_invocation", open: true };
  }
  db.exec("BEGIN");
  return { savepoint: null, open: true };
}

function commitInvocationTransaction(
  db: DatabaseSync,
  transaction: InvocationTransaction
): void {
  db.exec(
    transaction.savepoint ? `RELEASE ${transaction.savepoint}` : "COMMIT"
  );
  transaction.open = false;
}

function rollbackInvocationTransaction(
  db: DatabaseSync,
  transaction: InvocationTransaction
): void {
  if (!transaction.open) return;
  if (transaction.savepoint) {
    db.exec(`ROLLBACK TO ${transaction.savepoint}`);
    db.exec(`RELEASE ${transaction.savepoint}`);
  } else {
    db.exec("ROLLBACK");
  }
  transaction.open = false;
}

/**
 * THE ENGINE IS THE CHECK NOW (#916, adversarial BUG-10).
 *
 * `POLY_RULES` listed five of the fifteen polymorphic mechanisms and validated
 * their targets here, after the fact, by hand — so `enrich.upsert_embedding`
 * accepted a ghost id and `atlas.insert` could write a `core.share_origin` row
 * at a row that did not exist. Every `(type, id)` pair is a composite FOREIGN
 * KEY into `core_entity` since rung ten, so the engine refuses the write at
 * the statement, for all fifteen, and `polymorphicDenial` below turns its
 * one-line complaint back into something a member can act on.
 *
 * The denial names the PAIR that failed, not the registry: an earlier draft
 * also walked `ENTITY_POINTERS` to list the fourteen pointer tables, on every
 * foreign-key failure, and appended nothing. Naming them would not diagnose
 * this failure either — the member supplied a `(type, id)`, and which tables
 * happen to carry pointers is not what is wrong with it.
 */
export function polymorphicDenial(
  writes: { entityType: string; entityId: string }[],
  error: unknown
): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/FOREIGN KEY constraint failed/iu.test(message)) return null;
  // Name the pair the caller most likely got wrong: the last entity written.
  const write = writes.at(-1);
  const named = write ? `${write.entityType} ${write.entityId}: ` : "";
  return (
    `${named}a polymorphic pointer names an entity that does not exist. ` +
    `Every (type, id) pair is a foreign key into core_entity — the pair has to ` +
    `name a live row of a registered entity.`
  );
}

export function pkColumn(vault: DatabaseSync, physical: string): string {
  const rows = vault
    .prepare(`PRAGMA table_info(${JSON.stringify(physical)})`)
    .all() as {
    name: string;
    pk: number;
  }[];
  return rows.find((r) => r.pk === 1)?.name ?? "rowid";
}

/** Every write passes here: sealed columns are ciphertext BEFORE commit (#293). */
export function sealWrites(
  db: VaultDb,
  writes: { entityType: string; entityId: string }[]
): void {
  let sealedAny = false;
  for (const write of writes) {
    const cols = sealedColumnsOf(write.entityType, db.vault);
    if (cols.length === 0) continue;
    const ref = resolveEntity(write.entityType, db.vault);
    if (!ref) continue;
    const pk = pkColumn(db.vault, ref.physical);
    const select = cols.map((c) => `"${c}"`).join(", ");
    const row = db.vault
      .prepare(`SELECT ${select} FROM "${ref.physical}" WHERE "${pk}" = ?`)
      .get(write.entityId) as Record<string, unknown> | undefined;
    if (!row) continue; // deleted within the same command
    for (const col of cols) {
      const value = row[col];
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        isSealedValue(value)
      )
        continue;
      db.vault
        .prepare(`UPDATE "${ref.physical}" SET "${col}" = ? WHERE "${pk}" = ?`)
        .run(
          sealValue(
            db.sealKey,
            sealAad(ref.physical, col, write.entityId),
            value
          ),
          write.entityId
        );
      sealedAny = true;
    }
  }
  // Stamped inside this transaction (#298), so "has secrets" and the secrets
  // commit together; opening without the key then fails loudly.
  if (sealedAny) stampSealKeyFingerprint(db.vault, db.sealKey);
}

export function insertInvocation(
  db: VaultDb,
  request: InvokeRequest,
  command: CommandRow,
  identity: Identity,
  grantId: string | null,
  status: string,
  fixedId?: string,
  sealedInput: readonly string[] = []
): string {
  const invocationId = fixedId ?? request.invocationId ?? uuidv7();
  db.audit
    .prepare(
      `INSERT INTO agent_command_invocation (invocation_id, command_id, caller_id, grant_id, input_json, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      invocationId,
      command.command_id,
      identity.callerId,
      grantId,
      // The journal is append-only (#293): declared secrets land as keyed
      // tokens, never values — a leak here is permanent. Command-aware (#298).
      JSON.stringify(
        redactCommandInput(
          db.sealKey,
          command.name,
          request.input,
          sealedInput,
          db.vault
        )
      ),
      status,
      nowIso()
    );
  return invocationId;
}

/**
 * BEFORE any handler. Commit repair repeats it only as a corruption guard: a
 * conflict found there already left an unaudited write.
 */
export function assertInvocationIdentity(
  db: VaultDb,
  invocationId: string,
  commandId: string,
  callerId: string,
  grantId: string | null
): boolean {
  const existing = db.audit
    .prepare(
      `SELECT command_id, caller_id, grant_id
         FROM agent_command_invocation
        WHERE invocation_id = ?`
    )
    .get(invocationId) as
    | { command_id: string; caller_id: string; grant_id: string | null }
    | undefined;
  if (!existing) return false;
  if (
    existing.command_id !== commandId ||
    existing.caller_id !== callerId ||
    existing.grant_id !== grantId
  ) {
    throw new GatewayError(
      "contract",
      `invocation id ${invocationId} is already bound to another command, caller, or grant`
    );
  }
  return true;
}

export function setInvocationStatus(
  db: VaultDb,
  invocationId: string,
  status: string
): void {
  db.audit
    .prepare(
      "UPDATE agent_command_invocation SET status = ? WHERE invocation_id = ?"
    )
    .run(status, invocationId);
}

function scrubAuditValue(
  value: unknown,
  scrub: (text: string) => string
): unknown {
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value))
    return value.map((item) => scrubAuditValue(item, scrub));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        scrubAuditValue(item, scrub),
      ])
    );
  }
  return value;
}

function receiptOutput(
  journal: DatabaseSync,
  receiptId: string | null
): unknown {
  if (!receiptId) return null;
  const receipt = journal
    .prepare("SELECT detail_json FROM access_receipt WHERE receipt_id = ?")
    .get(receiptId) as { detail_json: string | null } | undefined;
  if (!receipt?.detail_json) return null;
  return (
    (JSON.parse(receipt.detail_json) as { output?: unknown }).output ?? null
  );
}

/** A re-sent invocation id never double-writes. */
export function replayInvocation(
  db: VaultDb,
  invocationId: string,
  options: { deferCommitSettlement?: boolean } = {}
): InvokeOutcome | null {
  const denied = readDurableParkedDenial(db, invocationId);
  if (denied) return { status: "denied", ...denied };
  // Commit proof outranks journal status: it carries the S5 material that
  // repairs a crash-left audit prefix before replay returns.
  const committed = readReplicaInvocationCommit(db.vault, invocationId);
  if (committed) {
    const finalized = committed.intentId
      ? finalizeReplicaInvocationCommit(db, invocationId, {
          deferSettlement: options.deferCommitSettlement,
        })
      : finalizeOrdinaryInvocationCommit(db, invocationId, {
          deferSettlement: options.deferCommitSettlement,
        });
    const output = receiptOutput(db.audit, finalized.receiptId);
    return {
      status: "replayed",
      invocationId,
      output,
    };
  }
  const row = db.audit
    .prepare(
      "SELECT status, receipt_id FROM agent_command_invocation WHERE invocation_id = ?"
    )
    .get(invocationId) as
    | { status: string; receipt_id: string | null }
    | undefined;
  if (row?.status === "executed") {
    return {
      status: "replayed",
      invocationId,
      output: receiptOutput(db.audit, row.receipt_id),
    };
  }
  if (row && (row.status === "failed" || row.status === "rolled_back")) {
    const receipt = db.audit
      .prepare(
        `SELECT receipt_id, detail_json
           FROM access_receipt
          WHERE invocation_id = ? AND decision = 'deny'
          ORDER BY occurred_at DESC, receipt_id DESC
          LIMIT 1`
      )
      .get(invocationId) as
      | { receipt_id: string; detail_json: string | null }
      | undefined;
    if (receipt) {
      const detail = receipt.detail_json
        ? (JSON.parse(receipt.detail_json) as {
            failing?: unknown;
            error?: unknown;
            predicate?: unknown;
          })
        : {};
      const reason = [detail.failing, detail.error, detail.predicate].find(
        (value): value is string =>
          typeof value === "string" && value.length > 0
      );
      return {
        status: "failed",
        invocationId,
        receiptId: receipt.receipt_id,
        reason: reason ?? `invocation ${row.status}`,
      };
    }
  }
  if (row) {
    const parked = readDurableParkedPayload(db, invocationId);
    return parked
      ? { status: "parked", invocationId, reason: parked.reason }
      : null;
  }
  return null;
}

export function runContractAndExecute(
  db: VaultDb,
  commands: ReadonlyMap<string, RegisteredCommand>,
  identity: Identity,
  request: InvokeRequest,
  command: CommandRow,
  access: AccessAllow,
  invocationId: string,
  confirmation?: Record<string, unknown>,
  onProvenanceCommitted?: (entityTypes: readonly string[]) => void,
  options: {
    deferCommitSettlement?: boolean;
    deferReplicaNotify?: boolean;
    /**
     * Ids from a seed, not the clock, so a Commons replica derives identical
     * row ids (#750). NOTHING else may set it: a shared seed collides.
     */
    deterministicIdSeed?: string;
  } = {}
): InvokeOutcome {
  const purpose = request.purpose ?? DEFAULT_PURPOSE;
  const denyContract = (
    predicate: string,
    detail: Record<string, unknown>
  ): InvokeOutcome => {
    setInvocationStatus(db, invocationId, "failed");
    const receiptId = writeReceipt(db.audit, {
      grantId: access.grantId,
      invocationId,
      action: `act ${command.name}`,
      objectType: "agent.command",
      objectId: command.command_id,
      purpose,
      decision: "deny",
      detail: { ...detail, risk: command.risk },
    });
    writeExplanation(
      db.audit,
      invocationId,
      `${command.name} did not run: ${predicate}.`
    );
    return {
      status: "failed",
      invocationId,
      receiptId,
      reason: predicate,
      predicate,
    };
  };

  // Compatibility is EQUALITY on purpose (#310): one served ontology version,
  // so a mismatch is a stale registration, not an old client.
  if (command.ontology_version !== ONTOLOGY_VERSION) {
    return denyContract(
      `contract version ${command.ontology_version} not served`,
      {
        stage: "contract",
        commandVersion: command.ontology_version,
        gatewayVersion: ONTOLOGY_VERSION,
      }
    );
  }
  const sealedInput = commands.get(command.name)?.sealedInput ?? [];
  // Error surfaces get input_json's discipline (#298): runtime-derived text
  // passes the scrub before the journal, receipt or response.
  const secretValues = sealedValuesForCommand(
    command.name,
    request.input,
    sealedInput,
    db.vault
  );
  const scrub = (text: string): string =>
    scrubSealedText(db.sealKey, text, secretValues);
  const schemaErrors = validateJson(
    JSON.parse(command.input_schema_json),
    request.input
  ).map(scrub);
  if (schemaErrors.length > 0) {
    return denyContract(`input schema violation`, {
      stage: "contract",
      errors: schemaErrors,
    });
  }
  const preSpecs = JSON.parse(command.preconditions_json) as ConditionSpec[];
  const preResults = evaluateConditions(db.vault, preSpecs, request.input);
  for (const result of preResults) {
    writeCheck(
      db.audit,
      invocationId,
      "pre",
      result.predicate,
      result.passed,
      result.observed
    );
  }
  const failedPre = preResults.find((r) => !r.passed);
  if (failedPre) {
    // App-facing, so prefer the author's sentence; the raw predicate still
    // reaches the receipt and audit trail.
    return denyContract(failedPre.message ?? failedPre.predicate, {
      stage: "contract",
      predicate: failedPre.predicate,
    });
  }
  setInvocationStatus(db, invocationId, "checked");

  const writes: { entityType: string; entityId: string }[] = [];
  const citations: Citation[] = [];
  // Queued, flushed after the canonical COMMIT.
  const handlerReceipts: HandlerReceipt[] = [];
  const registered = commands.get(command.name);
  if (!registered)
    return denyContract("handler missing", { stage: "execution" });
  const handler = registered.handler;
  // Receipted as column names, never values.
  const unsealed = new Set<string>();
  // Handlers mint ids in a fixed order, so indexing the seed reproduces the
  // sequence. The shape stays UUIDv7-compatible; only ordering is traded away.
  let deterministicIdIndex = 0;
  const newId = options.deterministicIdSeed
    ? (): string => {
        const hex = createHash("sha256")
          .update(options.deterministicIdSeed!)
          .update(`:${deterministicIdIndex++}`)
          .digest("hex");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      }
    : uuidv7;
  const ctx: HandlerCtx = {
    db: db.vault,
    identity,
    invocationId,
    input: request.input,
    purpose,
    now: nowIso(),
    newId,
    wrote: (entityType, entityId) => writes.push({ entityType, entityId }),
    cite: (citation) => citations.push(citation),
    receipt: (receipt) => handlerReceipts.push(receipt),
    unseal: (entityType, entityId, column, ciphertext) => {
      const cell = `${entityType}.${column}`;
      if (!registered.unseals.includes(cell)) {
        throw new Error(`${command.name} does not declare unseal of ${cell}`);
      }
      const ref = resolveEntity(entityType, db.vault);
      if (!ref) throw new Error(`unknown entity ${entityType}`);
      // A stored ciphertext may be handed in (#916, D2): a pre-mutation
      // SNAPSHOT of this same row holds the previous value under the same
      // additional data, which is what lets Locker history be revisions
      // rather than a second history table.
      let stored: unknown = ciphertext;
      if (stored === undefined) {
        const pk = pkColumn(db.vault, ref.physical);
        stored = (
          db.vault
            .prepare(
              `SELECT "${column}" AS v FROM "${ref.physical}" WHERE "${pk}" = ?`
            )
            .get(entityId) as { v: unknown } | undefined
        )?.v;
      }
      if (stored == null) return null;
      unsealed.add(cell);
      const value = String(stored);
      return isSealedValue(value)
        ? unsealValue(
            db.sealKey,
            sealAad(ref.physical, column, entityId),
            value
          )
        : value;
    },
    // Claims and spills are row work (#296): bytes already sit in the local
    // CAS, so a rollback at worst orphans a file the sweep reclaims.
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
      claimStaged: (sha256, optionsLocal) =>
        promoteStagedBlob(
          {
            vault: db.vault,
            now: nowIso(),
            newId,
            wrote: (entityType, entityId) =>
              writes.push({ entityType, entityId }),
            creatorPartyId: identity.partyId,
          },
          sha256,
          optionsLocal
        ),
      spill: (bytes) => db.blobs.ingestSync(bytes).sha256,
      has: (sha256) => db.blobs.hasSync(sha256),
    },
  };
  let output!: Record<string, unknown>;
  let audit!: ReplicaInvocationAudit;
  let postResults: ReturnType<typeof evaluateConditions> = [];
  // OUTSIDE the transaction (#916): the capture triggers are TEMP objects, and
  // creating them inside a transaction that later rolls back would take them
  // with it.
  openRevisionCapture(db.vault);
  const vaultTransaction = beginInvocationTransaction(db.vault);
  let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
  try {
    replicaCommit = beginReplicaCommit(db.vault);
    output = handler(ctx);
    // BEFORE `sealWrites`, and then the gate closes (#916): sealing REWRITES
    // the cells the handler just wrote, so a capture still open would take the
    // pre-seal row — the plaintext — as its snapshot. What a revision holds is
    // the row as the command FOUND it, which was already ciphertext at rest.
    if (!registered.erasure)
      drainRevisionCapture(db.vault, {
        invocationId,
        actorPartyId: identity.partyId ?? null,
        now: ctx.now,
      });
    closeRevisionCapture(db.vault);
    // Same transaction, so no committed row ever holds a clear secret (#293).
    sealWrites(db, writes);
    const postSpecs = JSON.parse(
      command.postconditions_json
    ) as ConditionSpec[];
    postResults = evaluateConditions(db.vault, postSpecs, {
      ...request.input,
      ...output,
    });
    const failedPost = postResults.find((r) => !r.passed);
    if (failedPost) {
      rollbackInvocationTransaction(db.vault, vaultTransaction);
      closeRevisionCapture(db.vault);
      for (const r of postResults)
        writeCheck(
          db.audit,
          invocationId,
          "post",
          r.predicate,
          r.passed,
          r.observed
        );
      setInvocationStatus(db, invocationId, "rolled_back");
      // Same split as the precondition path: friendly for the app, raw in the
      // receipt detail.
      const friendly = failedPost.message ?? failedPost.predicate;
      const receiptId = writeReceipt(db.audit, {
        grantId: access.grantId,
        invocationId,
        action: `act ${command.name}`,
        objectType: "agent.command",
        objectId: command.command_id,
        purpose,
        decision: "deny",
        detail: {
          stage: "execution",
          predicate: failedPost.predicate,
          risk: command.risk,
        },
      });
      writeExplanation(
        db.audit,
        invocationId,
        `${command.name} rolled back: ${friendly}.`
      );
      return {
        status: "failed",
        invocationId,
        receiptId,
        reason: friendly,
        predicate: friendly,
      };
    }
    // INSIDE the transaction: a demo row that escaped the registry would be
    // unpurgeable and visible to triggers (#290).
    if (request.demo) {
      const seedStmt = db.vault.prepare(
        `INSERT INTO access_seed_row (seed_id, app_id, target_type, target_id, seeded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (target_type, target_id) DO NOTHING`
      );
      for (const write of writes) {
        seedStmt.run(
          uuidv7(),
          request.demo.appId,
          write.entityType,
          write.entityId,
          ctx.now
        );
      }
    }

    const provenance = {
      activity: request.demo ? SEED_DEMO_ACTIVITY : `command.${command.name}`,
      used: request.demo
        ? {
            invocation: invocationId,
            command: command.name,
            app: request.demo.appId,
          }
        : { invocation: invocationId },
    };
    // Replay reads output back from the receipt; replica intents omit the
    // field deliberately, and their replay returns null.
    const durableOutput = registered.transcriptSensitive
      ? { redacted: "transcript-sensitive derivative (issue #298 item 6)" }
      : output;
    audit = {
      commandName: command.name,
      agentId: identity.callerId,
      agentKind: identity.provAgentKind,
      grantId: access.grantId,
      purpose,
      preconditionCount: preResults.length,
      postChecks: postResults.map((result) => ({
        predicate: result.predicate,
        passed: result.passed,
        observed: scrubAuditValue(result.observed, scrub) as Record<
          string,
          unknown
        >,
      })),
      writes: writes.map((write) => ({ ...write })),
      citations: citations.map((citation) => ({ ...citation })),
      provenance,
      receiptDetail: {
        ...(request.intentId ? {} : { output: durableOutput }),
        ...actingOwnerDetail(identity, request),
        writes: writes.map((write) => ({ ...write })),
        // The salience marker (#306): risk no longer gates execution.
        risk: command.risk,
        ...(unsealed.size > 0 ? { unsealed: [...unsealed] } : {}),
        ...(confirmation ? { confirmation } : {}),
      },
    };

    // Every canonical transaction carries the marker; ordinary invocations
    // reclaim it after journal proof below.
    recordReplicaInvocationCommitInTransaction(db.vault, {
      invocationId,
      commandId: command.command_id,
      ...(request.intentId ? { intentId: request.intentId } : {}),
      audit,
      committedAt: ctx.now,
    });
    endReplicaCommit(db.vault, replicaCommit);
    commitInvocationTransaction(db.vault, vaultTransaction);
    closeRevisionCapture(db.vault);
    if (!options.deferReplicaNotify) notifyReplicaCommit(db.vault);
  } catch (error) {
    rollbackInvocationTransaction(db.vault, vaultTransaction);
    closeRevisionCapture(db.vault);
    setInvocationStatus(db, invocationId, "failed");
    // A message echoing its input would put a secret in the journal (#298).
    const reason = scrub(
      error instanceof Error ? error.message : String(error)
    );
    const receiptId = writeReceipt(db.audit, {
      grantId: access.grantId,
      invocationId,
      action: `act ${command.name}`,
      objectType: "agent.command",
      objectId: command.command_id,
      purpose,
      decision: "deny",
      detail: { stage: "execution", error: reason, risk: command.risk },
    });
    writeExplanation(
      db.audit,
      invocationId,
      `${command.name} failed during execution: ${reason}.`
    );
    return { status: "failed", invocationId, receiptId, reason };
  }

  // One idempotent journal transaction after the canonical COMMIT: if it
  // aborts, the marker survives and replay repairs it without re-entry.
  const finalized = request.intentId
    ? finalizeReplicaInvocationCommit(db, invocationId, {
        deferSettlement: options.deferCommitSettlement,
      })
    : finalizeOrdinaryInvocationCommit(db, invocationId, {
        deferSettlement: options.deferCommitSettlement,
      });
  // After the write they describe is durable and after the invocation's, so
  // the stream reads in the order facts became true.
  for (const receipt of handlerReceipts)
    writeReceipt(db.audit, {
      grantId: receipt.grantId,
      invocationId,
      action: receipt.action,
      objectType: receipt.objectType,
      objectId: receipt.objectId,
      purpose,
      decision: receipt.decision,
      ...(receipt.detail ? { detail: receipt.detail } : {}),
    });
  // Strictly post-journal-commit, so every provenance row is readable first.
  // Best-effort: a thrown host callback must not fail a committed write.
  try {
    onProvenanceCommitted?.([
      ...new Set(writes.map((write) => write.entityType)),
    ]);
  } catch {
    // Hint only; the persisted cursor and poll own correctness.
  }
  return {
    status: "executed",
    invocationId,
    receiptId: finalized.receiptId,
    output,
  };
}
