// governance: allow-repo-hygiene file-size-limit the one-door pipeline (§10) — identity → consent → contract → execution → evidence must stay one auditable unit
// Gateway (§10): one door. Identity → consent → contract → execution → evidence. No domain logic. Byte custody (#296) rides the same door.

import type { DatabaseSync } from "node:sqlite";

import { refreshCustodyRollup } from "../blob/custody-rollup.js";
import { refreshCustodyState } from "../blob/custody.js";
import type { ReconcileResult } from "../blob/custody.js";
import { backfillPreviews } from "../blob/preview.js";
import { resolveServableBlob, liveBlobShas } from "../blob/read.js";
import type { BlobResolveOutcome } from "../blob/read.js";
import { stageBlobBytes } from "../blob/staging.js";
import type { StageBlobOptions, StagedBlob } from "../blob/staging.js";
import { conversationArchiveShas } from "../conversation-archive-roots.js";
import type { VaultDb } from "../db.js";
import { recomputeDuplicateClusters } from "../enrich/clusters.js";
import {
  AGENT_CONTENT_VARIANTS,
  resolveAgentContent,
} from "../enrich/content.js";
import type {
  AgentContentOutcome,
  AgentContentVariant,
} from "../enrich/content.js";
import { rebuildFaceClusters } from "../enrich/face-clusters.js";
import {
  drainSatisfiedEnrichmentRequests,
  queueMissingDeviceEnrichmentBacklog,
  releaseExpiredEnrichmentLeases,
} from "../enrich/leases.js";
import { rebuildMemories } from "../enrich/memories.js";
import {
  routeShareGrantEdit,
  shareGrantEditRefusal,
} from "../grant/fulfillment-edit.js";
import { resolveAudienceParties } from "../grant/grant-store.js";
import { nowIso, uuidv7 } from "../ids.js";
import { importIcsEvents, importVcardParties } from "../ingest/import.js";
import type { ImportResult } from "../ingest/import.js";
import { PUBLISHERS } from "../ingest/publishers.js";
import { stageFile } from "../ingest/stage-file.js";
import type {
  StageFileOptions,
  StageFileResult,
} from "../ingest/stage-file.js";
import { discardBatch, publishBatch } from "../ingest/staging.js";
import type { PublishResult } from "../ingest/staging.js";
import { archivedSegmentShas } from "../journal-archive.js";
import { beginReplicaCommit, endReplicaCommit } from "../replica/change-log.js";
import { notifyReplicaCommit } from "../replica/doorbell.js";
import { transitionReplicaIntentOutcomeInTransaction } from "../replica/intents.js";
import {
  reclaimProvenOrdinaryInvocationCommitsInTransaction,
  stampFinalizedInvocationCommitInTransaction,
} from "../replica/invocation-commits.js";
import {
  deleteDurableParkedPayloadsForGrant,
  listDurableParkedPayloads,
  readDurableParkedDenial,
  readDurableParkedPayload,
  recordDurableParkedDenial,
  saveDurableParkedPayload,
  settleDurableParkedPayload,
} from "../replica/parked.js";
import type { ExtTableSpec } from "../schema/ext.js";
import { ONTOLOGY_VERSION } from "../schema/migrate.js";
import {
  isSealedValue,
  redactCommandInput,
  sealAad,
  SEALED_PLACEHOLDER,
  sealedColumnsOf,
  stampSealKeyFingerprint,
  unsealValue,
} from "../schema/sealed.js";
import { SEED_DEMO_ACTIVITY } from "../schema/seed.js";
import { resolveEntity } from "../schema/tables.js";
import { isCommonsCommandActable } from "../share/commons-routing.js";
import {
  appendCommonsOperation,
  appendCommonsOperationInTransaction,
  assertCommonsWithinMax,
  CommonsMaxSizeError,
  commonsGrantForCommand,
  queueCommonsIntent,
  sequenceCommonsCircleCommandInTransaction,
} from "../share/commons.js";
import { evaluateAccess } from "./access.js";
import type { AccessAllow } from "./access.js";
import { resolveRefCards } from "./cards.js";
import type { RefRequest, ResolveResult } from "./cards.js";
import { lookupCommand } from "./contract.js";
import { backupVault, checkpointVault } from "./custody.js";
import type { BackupResult } from "./custody.js";
import { demoStatus, purgeDemoRows } from "./demo.js";
import type { DemoPurgeResult } from "./demo.js";
import { revokeGrantCascade, sweepLifecycle } from "./duties.js";
import type { RevocationResult, SweepResult } from "./duties.js";
import { actingOwnerDetail, writeReceipt } from "./evidence.js";
import {
  assertInvocationIdentity,
  insertInvocation,
  replayInvocation,
  pkColumn,
  runContractAndExecute,
  setInvocationStatus,
} from "./execution.js";
import type { RegisteredCommand } from "./execution.js";
import {
  applyExtBand,
  dropExtBand,
  extAppIds,
  extCommandDefinitions,
  extCommandNames,
  purgeExtBand,
  retainExtBand,
  seedExtDraft,
} from "./ext.js";
import type { ExtApplyOutcome } from "./ext.js";
import {
  applyFieldMask,
  compileFilters,
  compileOrderBy,
  scalarPrimaryKeyColumn,
} from "./filters.js";
import { authenticate } from "./identity.js";
import { LockerAuthentication } from "./locker-auth.js";
import type { LockerAuthRequest, LockerAuthResult } from "./locker-auth.js";
import { exportVault } from "./portability.js";
import type { VaultExport } from "./portability.js";
import { exportPortableVault } from "./portable-export.js";
import type {
  PortableExport,
  PortableExportOptions,
} from "./portable-export.js";
import { searchEntity } from "./search.js";
import { runReadOnlySql, VAULT_SQL_DEFAULT_ROWS } from "./sql.js";
import type { VaultSqlRequest, VaultSqlResult } from "./sql.js";
import type {
  ChangeEntry,
  ChangesRequest,
  ChangesResult,
  CommandDefinition,
  Credential,
  Identity,
  InvokeOutcome,
  InvokeRequest,
  ParkedCallerKind,
  ParkedSummary,
  ReadRequest,
  ReadResult,
  RevealRequest,
  RevealResult,
  Risk,
  SearchRequest,
  SearchResult,
} from "./types.js";
import { DEFAULT_PURPOSE, GatewayError } from "./types.js";

/** Non-owner provenance reads (#352) must scope to one (entity_type, entity_id) and hold read on that entity's table. */
function provenanceScopeFailure(
  vault: DatabaseSync,
  identity: Identity,
  request: ReadRequest
): string | null {
  const eqValue = (column: string): string | undefined => {
    const clause = (request.where ?? []).find(
      (c) => c.column === column && c.op === "eq"
    );
    return typeof clause?.value === "string" ? clause.value : undefined;
  };
  const targetType = eqValue("entity_type");
  const targetId = eqValue("entity_id");
  if (!targetType || !targetId) {
    return "activity reads must scope to exactly one entity_type and one entity_id (eq filters)";
  }
  const targetRef = resolveEntity(targetType, vault);
  if (!targetRef) {
    return `activity target names unknown entity "${targetType}"`;
  }
  const targetConsent = evaluateAccess(
    vault,
    identity,
    targetRef.schema,
    targetRef.table,
    "read",
    request.purpose
  );
  if (targetConsent.decision === "deny") {
    return `no read consent for ${targetType}: ${targetConsent.failing}`;
  }
  return null;
}

/** Human pending-copy for a member intent. The steward party is part of the
 * projected Commons closure; absence is tolerated for old/incomplete seats. */
function commonsStewardDeviceLabel(
  vault: DatabaseSync,
  stewardPartyId: string
): string {
  const row = vault
    .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
    .get(stewardPartyId) as { display_name: string } | undefined;
  const label = row?.display_name.trim().replace(/\s+/gu, " ");
  if (!label) return "the commons steward's device";
  const possessive = /['’]s$/iu.test(label)
    ? label
    : /['’]$/u.test(label)
      ? `${label}s`
      : `${label}'s`;
  return `${possessive} device`;
}

/**
 * Locker's sealed SIDECAR entities (#873): rows that hang off an item and
 * carry secret material of their own. Their reveal spends the OWNING item's
 * one-time permit — a permit is minted per item, never per field/revision.
 */
// `locker.item_history` is NOT one of them any more (#916, D2): the table is
// gone and a previous value lives in a `core_entity_revision` snapshot, which
// records that a sealed column changed and never what it changed to. There is
// no secret in a revision to spend a permit on.
const LOCKER_SIDECAR_ENTITIES = new Set([
  "locker.item_field",
  "locker.item_passkey",
]);

export interface GatewayDeps {
  /** Best-effort hint emitted only after audit-band provenance is durable. */
  onProvenanceCommitted?: (entityTypes?: readonly string[]) => void;
  /** Best-effort hint after the parked-decision projection changes. */
  onDecisionChanged?: (created: boolean) => void;
  /** Runs only after the command/log transaction commits. */
  onCommonsCommandSequenced?: (grantId: string) => void;
  /** Doorbell emitted after a member intent is durably queued. */
  onCommonsIntentQueued?: (grantId: string) => void;
}

export type InvocationBatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

/** A Commons failure is still inside the pre-commit batch and must roll back
 * the command marker and domain rows. */
const commonsOperationErrors = new WeakSet<object>();
function markCommonsOperationError(source: unknown): Error {
  const error = new Error(
    source instanceof Error ? source.message : String(source)
  );
  error.name = "CommonsOperationError";
  commonsOperationErrors.add(error);
  return error;
}
function isCommonsOperationError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    commonsOperationErrors.has(value)
  );
}

export class Gateway {
  /** Registered commands: handler + sealed-class declarations (#293). */
  private readonly commands = new Map<string, RegisteredCommand>();
  private readonly lockerAuthentication: LockerAuthentication;
  private activeBatchInvocationIds: string[] | undefined;
  private activeBatchDecisionChanges: boolean[] | undefined;
  private activeBatchCommonsGrantIds: string[] | undefined;
  private activeBatchCommonsIntentGrantIds: string[] | undefined;

  constructor(
    private readonly db: VaultDb,
    private readonly deps: GatewayDeps = {}
  ) {
    this.lockerAuthentication = new LockerAuthentication(db);
  }

  /**
   * Host-only Locker authentication plane; app bridges restrict the caller.
   * ASYNC (#659 G11): the scrypt derivation runs on the threadpool rather than
   * blocking the gateway's event loop, so callers must await.
   */
  authenticateLocker(request: LockerAuthRequest): Promise<LockerAuthResult> {
    return this.lockerAuthentication.handle(request);
  }

  /** Consume the one-time permit before a Locker UI reveal. */
  authorizeLockerReveal(
    authentication: RevealRequest["authentication"],
    itemId: string
  ): void {
    this.lockerAuthentication.authorizeReveal(authentication, itemId, "ui");
  }

  /**
   * Data-keyed Locker reveal gate (#630 review). Lives on the gateway so every
   * reveal arm — app bridge, agent bridge, tests — hits the same lock.
   */
  private enforceLockerReveal(
    request: RevealRequest,
    entityId: string,
    isFill: boolean
  ): void {
    this.lockerAuthentication.authorizeReveal(
      request.authentication,
      entityId,
      isFill ? "fill" : "ui"
    );
  }

  /**
   * The item whose permit a Locker reveal spends (#873). `locker.item` spends
   * its own; a sealed sidecar row spends the item it hangs off, resolved from
   * the requested row. Null when that row is gone or its item is trashed —
   * the caller then refuses with the SAME shape a missing item gets, after
   * the permit gate has already run, so the sidecars are no existence oracle.
   */
  private lockerOwningItemId(
    entity: string,
    physical: string,
    entityId: string
  ): string | null {
    if (!LOCKER_SIDECAR_ENTITIES.has(entity)) return entityId;
    const pk = pkColumn(this.db.vault, physical);
    const row = this.db.vault
      .prepare(
        `SELECT i.item_id FROM "${physical}" s
           JOIN locker_item i ON i.item_id = s.item_id
          WHERE s."${pk}" = ? AND i.deleted_at IS NULL`
      )
      .get(entityId) as { item_id: string } | undefined;
    return row?.item_id ?? null;
  }

  /**
   * One short arrival window inside a shared vault + journal commit pair. Each
   * invocation keeps its own savepoints, contract checks and outcome;
   * successful canonical markers are stamped provisionally and re-verified
   * before a later shared pair reclaims them.
   */
  invokeBatch<T>(runs: readonly (() => T)[]): T[] {
    return this.invokeBatchSettled(runs).map((result) => {
      if (!result.ok) throw result.error;
      return result.value;
    });
  }

  /** Each run owns matching vault and journal savepoints: a failure rolls back
   * both sides plus provisional markers, while siblings may still commit. */
  invokeBatchSettled<T>(
    runs: readonly (() => T)[]
  ): InvocationBatchResult<T>[] {
    if (runs.length === 0) return [];
    if (
      this.activeBatchInvocationIds ||
      this.db.vault.isTransaction ||
      this.db.audit.isTransaction
    ) {
      throw new Error("gateway invocation batch cannot nest");
    }
    const invocationIds: string[] = [];
    const decisionChanges: boolean[] = [];
    const commonsGrantIds: string[] = [];
    const commonsIntentGrantIds: string[] = [];
    this.activeBatchInvocationIds = invocationIds;
    this.activeBatchDecisionChanges = decisionChanges;
    this.activeBatchCommonsGrantIds = commonsGrantIds;
    this.activeBatchCommonsIntentGrantIds = commonsIntentGrantIds;
    try {
      // ONE FILE (#916): the vault and the audit band are the same handle, so
      // the batch is ONE transaction. Beginning twice is now an error, and the
      // two-phase dance the pair needed is simply gone.
      this.db.vault.exec("BEGIN IMMEDIATE");
      const replicaCommit = beginReplicaCommit(this.db.vault);
      reclaimProvenOrdinaryInvocationCommitsInTransaction(this.db);
      const results = runs.map((run, index): InvocationBatchResult<T> => {
        const savepoint = `gateway_batch_run_${index}`;
        const invocationLength = invocationIds.length;
        const decisionLength = decisionChanges.length;
        const commonsLength = commonsGrantIds.length;
        const commonsIntentLength = commonsIntentGrantIds.length;
        const markersBefore = new Set(
          (
            this.db.vault
              .prepare("SELECT invocation_id FROM replica_invocation_commit")
              .all() as { invocation_id: string }[]
          ).map((row) => row.invocation_id)
        );
        this.db.vault.exec(`SAVEPOINT ${savepoint}`);
        try {
          const value = run();
          this.db.vault.exec(`RELEASE ${savepoint}`);
          return { ok: true, value };
        } catch (error) {
          // A command can cross the vault commit then fail finalizing journal
          // evidence: preserve marker and domain writes so the next retry
          // repairs the journal exactly once.
          const committedAfterStart = (
            this.db.vault
              .prepare("SELECT invocation_id FROM replica_invocation_commit")
              .all() as { invocation_id: string }[]
          ).some((row) => !markersBefore.has(row.invocation_id));
          // Commons byte-budget rejection is PRE-commit policy failure — no
          // domain/op row may escape the batch.
          const shouldRollback =
            error instanceof CommonsMaxSizeError ||
            isCommonsOperationError(error) ||
            !committedAfterStart;
          if (shouldRollback) {
            this.db.vault.exec(`ROLLBACK TO ${savepoint}`);
          }
          this.db.vault.exec(`RELEASE ${savepoint}`);
          invocationIds.length = invocationLength;
          decisionChanges.length = decisionLength;
          commonsGrantIds.length = commonsLength;
          commonsIntentGrantIds.length = commonsIntentLength;
          return { ok: false, error };
        }
      });
      for (const invocationId of invocationIds) {
        stampFinalizedInvocationCommitInTransaction(
          this.db.vault,
          invocationId
        );
      }
      endReplicaCommit(this.db.vault, replicaCommit);
      this.db.vault.exec("COMMIT");
      // Publish only runs now durable.
      notifyReplicaCommit(this.db.vault);
      if (decisionChanges.length > 0) {
        this.emitDecisionChanged(decisionChanges.some(Boolean));
      }
      for (const grantId of new Set(commonsGrantIds))
        this.emitCommonsCommandSequenced(grantId);
      for (const grantId of new Set(commonsIntentGrantIds))
        this.emitCommonsIntentQueued(grantId);
      return results;
    } catch (error) {
      if (this.db.vault.isTransaction) this.db.vault.exec("ROLLBACK");
      throw error;
    } finally {
      this.activeBatchInvocationIds = undefined;
      this.activeBatchDecisionChanges = undefined;
      this.activeBatchCommonsGrantIds = undefined;
      this.activeBatchCommonsIntentGrantIds = undefined;
    }
  }

  private trackBatchInvocation(outcome: InvokeOutcome): InvokeOutcome {
    if (
      this.activeBatchInvocationIds &&
      (outcome.status === "executed" || outcome.status === "replayed")
    ) {
      this.activeBatchInvocationIds.push(outcome.invocationId);
    }
    return outcome;
  }

  /** Reconciliation is post-commit and must never turn durable success into a
   * reported failure; mount/peer sweeps repair a missed hint. */
  private emitCommonsCommandSequenced(grantId: string): void {
    try {
      this.deps.onCommonsCommandSequenced?.(grantId);
    } catch {
      // Restore reconciliation is the durable retry path, so this post-commit
      // notification must not throw.
    }
  }

  /** Recovered by the bounded sweep, so a prompt wake is best-effort and must
   * not turn a durable queue write into a failure. */
  private emitCommonsIntentQueued(grantId: string): void {
    try {
      this.deps.onCommonsIntentQueued?.(grantId);
    } catch {
      // A wake hook's throw must not fail the queueing it signals.
    }
  }

  registerCommand(def: CommandDefinition): void {
    const existing = lookupCommand(this.db.vault, def.name);
    const commandId = existing?.command_id ?? uuidv7();
    const params = [
      def.name,
      def.ownerSchema,
      JSON.stringify(def.inputSchema),
      JSON.stringify(def.outputSchema),
      JSON.stringify(def.preconditions),
      JSON.stringify(def.postconditions),
      def.idempotency,
      def.risk,
      ONTOLOGY_VERSION,
    ];
    // Confirmation is a Tier 3/4 property of the COMMAND (#306 decision 1),
    // never a function of risk — risk is only a salience marker.
    const requiresConfirmation = def.confirm === true ? 1 : 0;
    if (existing) {
      this.db.vault
        .prepare(
          `UPDATE agent_command SET name=?, owner_schema=?, input_schema_json=?, output_schema_json=?,
             preconditions_json=?, postconditions_json=?, idempotency=?, risk=?, ontology_version=?
           WHERE command_id=?`
        )
        .run(...params, commandId);
      this.db.vault
        .prepare(
          `UPDATE agent_capability SET requires_confirmation=? WHERE command_id=?`
        )
        .run(requiresConfirmation, commandId);
    } else {
      this.db.vault
        .prepare(
          `INSERT INTO agent_command (command_id, name, owner_schema, input_schema_json, output_schema_json,
             preconditions_json, postconditions_json, idempotency, risk, ontology_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(commandId, ...params);
      this.db.vault
        .prepare(
          `INSERT INTO agent_capability (capability_id, schema_name, verb, command_id, description, requires_confirmation)
           VALUES (?, ?, 'act', ?, ?, ?)`
        )
        .run(
          uuidv7(),
          def.ownerSchema,
          commandId,
          def.name,
          requiresConfirmation
        );
    }
    this.commands.set(def.name, {
      handler: def.handler,
      sealedInput: def.sealedInput ?? [],
      unseals: def.unseals ?? [],
      transcriptSensitive: def.transcriptSensitive ?? false,
      erasure: def.erasure ?? false,
    });
  }

  discover(cred: Credential): {
    name: string;
    schema: string;
    risk: Risk;
    requiresConfirmation: boolean;
  }[] {
    this.identify(cred);
    const rows = this.db.vault
      .prepare(
        `SELECT c.name, c.owner_schema, c.risk, cap.requires_confirmation
           FROM agent_command c JOIN agent_capability cap ON cap.command_id = c.command_id`
      )
      .all() as {
      name: string;
      owner_schema: string;
      risk: Risk;
      requires_confirmation: number;
    }[];
    return rows.map((r) => ({
      name: r.name,
      schema: r.owner_schema,
      risk: r.risk,
      requiresConfirmation: r.requires_confirmation === 1,
    }));
  }

  /** S1. Throws GatewayError('identity') — dropped at transport, no receipt. */
  private identify(cred: Credential): Identity {
    return authenticate(this.db.vault, cred);
  }

  read(cred: Credential, rawRequest: ReadRequest): ReadResult {
    const identity = this.identify(cred);
    const request = {
      ...rawRequest,
      purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
    };
    const ref = resolveEntity(request.entity, this.db.vault);
    if (!ref) {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: null,
        invocationId: null,
        action: "read",
        objectType: request.entity,
        objectId: null,
        purpose: request.purpose,
        decision: "deny",
        detail: { failing: "unknown entity" },
      });
      throw new GatewayError(
        "access",
        `deny (receipt ${receiptId}): unknown entity ${request.entity}`
      );
    }
    const access = evaluateAccess(
      this.db.vault,
      identity,
      ref.schema,
      ref.table,
      "read",
      request.purpose
    );
    if (access.decision === "deny") {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: access.grantId,
        invocationId: null,
        action: "read",
        objectType: request.entity,
        objectId: null,
        purpose: request.purpose,
        decision: "deny",
        detail: { failing: access.failing },
      });
      throw new GatewayError(
        "access",
        `deny (receipt ${receiptId}): ${access.failing}`
      );
    }
    // Per-entity activity guard — see `provenanceScopeFailure`.
    if (
      ref.schema === "access" &&
      ref.table === "provenance" &&
      identity.kind !== "owner-device"
    ) {
      const failing = provenanceScopeFailure(this.db.vault, identity, request);
      if (failing) {
        const receiptId = writeReceipt(this.db.audit, {
          grantId: access.grantId,
          invocationId: null,
          action: "read",
          objectType: request.entity,
          objectId: null,
          purpose: request.purpose,
          decision: "deny",
          detail: { failing },
        });
        throw new GatewayError(
          "access",
          `deny (receipt ${receiptId}): ${failing}`
        );
      }
    }
    // ONE file (#916): every resolvable entity lives in the vault handle.
    const target = this.db.vault;
    const now = nowIso();
    // An agent sees ITS invocations, so a parked send resumes by watching its
    // own rows. Appended beside the grant filter: narrows, never widens.
    const structuralFilter =
      identity.kind === "agent" && request.entity === "agent.command_invocation"
        ? [{ column: "caller_id", op: "eq" as const, value: identity.callerId }]
        : [];
    const grantFilter = compileFilters(
      target,
      ref.physical,
      [...access.rowFilter, ...structuralFilter],
      now
    );
    const callerFilter = compileFilters(
      target,
      ref.physical,
      request.where ?? [],
      now
    );
    const sealedCols = sealedColumnsOf(request.entity, this.db.vault);
    const scalarPrimaryKey = scalarPrimaryKeyColumn(target, ref.physical);
    const exposedPrimaryKey =
      scalarPrimaryKey !== undefined &&
      !sealedCols.includes(scalarPrimaryKey) &&
      (access.fieldMask === null || access.fieldMask.includes(scalarPrimaryKey))
        ? scalarPrimaryKey
        : undefined;
    // Ordering makes a bounded read a RECENT window (#262); validated like a
    // filter column so it cannot widen anything.
    const order = compileOrderBy(
      target,
      ref.physical,
      request.orderBy,
      exposedPrimaryKey
    );
    const select = applyFieldMask(target, ref.physical, access.fieldMask);
    const limit = Math.min(Math.max(request.limit ?? 1000, 1), 10_000);
    // The automation plane never sees demo data (#290): a fake "rent due" row
    // must not fire a real reminder. Narrows, never widens.
    const demoExclusion =
      identity.kind === "agent" && ref.schema !== "access"
        ? ` AND NOT EXISTS (SELECT 1 FROM access_seed_row _s
             WHERE _s.target_type = ? AND _s.target_id = "${ref.physical}"."${pkColumn(target, ref.physical)}")`
        : "";
    const rows = target
      .prepare(
        `SELECT ${select} FROM "${ref.physical}" WHERE ${grantFilter.where} AND ${callerFilter.where}${demoExclusion}${order} LIMIT ${limit}`
      )
      .all(
        ...grantFilter.params,
        ...callerFilter.params,
        ...(demoExclusion ? [request.entity] : [])
      ) as Record<string, unknown>[];
    // Sealed columns never ride a read (#293): reads show a placeholder;
    // plaintext takes the `reveal` verb and its per-item receipt.
    if (sealedCols.length > 0) {
      for (const row of rows) {
        for (const col of sealedCols) {
          if (row[col] != null && row[col] !== "")
            row[col] = SEALED_PLACEHOLDER;
        }
      }
    }
    const receiptId = writeReceipt(this.db.audit, {
      grantId: access.grantId,
      invocationId: null,
      action: "read",
      objectType: request.entity,
      objectId: null,
      purpose: request.purpose,
      decision: "allow",
      detail: { filter: request.where ?? [], rowCount: rows.length },
    });
    return { rows, receiptId };
  }

  /**
   * Reveal (#293): plaintext of one entity's sealed columns under the `reveal`
   * verb — never `read`, never `read+act`. Owner devices pass unless readonly.
   * Every reveal writes a receipt naming the item and columns, so "what looked
   * at my secrets" always has an answer. Values never touch the journal.
   */
  reveal(cred: Credential, rawRequest: RevealRequest): RevealResult {
    const identity = this.identify(cred);
    const request = {
      ...rawRequest,
      purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
    };
    let context: { kind: "fill"; origin: string } | undefined;
    const deny = (failing: string, grantId: string | null = null): never => {
      const receiptId = writeReceipt(this.db.audit, {
        grantId,
        invocationId: null,
        action: "reveal",
        objectType: request.entity,
        objectId:
          request.entityId ?? (request.alias ? `@${request.alias}` : null),
        purpose: request.purpose,
        decision: "deny",
        detail: { failing, ...(context ? { context } : {}) },
      });
      throw new GatewayError(
        "access",
        `deny (receipt ${receiptId}): ${failing}`
      );
    };
    if (request.context !== undefined) {
      if (request.context.kind !== "fill")
        return deny("reveal context kind must be fill");
      try {
        const url = new URL(request.context.origin);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          request.context.origin !== url.origin
        ) {
          throw new Error("not an origin");
        }
        context = { kind: "fill", origin: url.origin };
      } catch {
        return deny("reveal fill context needs an absolute HTTP origin");
      }
    }
    const ref = resolveEntity(request.entity, this.db.vault);
    if (!ref) return deny(`unknown entity ${request.entity}`);
    const sealedCols = sealedColumnsOf(request.entity, this.db.vault);
    if (sealedCols.length === 0)
      return deny(`${request.entity} has no sealed columns`);
    const columns = request.columns ?? [...sealedCols];
    for (const col of columns) {
      if (!sealedCols.includes(col))
        return deny(`${col} is not a sealed column`);
    }
    // Alias → live item (#298). Only locker.item carries aliases, and the
    // lookup rides the reveal grant, so a connector survives a rotation.
    let entityId = request.entityId;
    if (request.alias !== undefined) {
      if (request.entity !== "locker.item")
        return deny("alias reveal is locker.item only");
      const hit = this.db.vault
        .prepare(
          `SELECT a.item_id FROM locker_item_alias a
             JOIN locker_item i ON i.item_id = a.item_id
            WHERE a.alias = ? AND i.deleted_at IS NULL`
        )
        .get(request.alias) as { item_id: string } | undefined;
      if (!hit)
        return deny(`no live locker item with alias "${request.alias}"`);
      entityId = hit.item_id;
    }
    if (!entityId) return deny("reveal needs an entityId or alias");
    // Locker lock is data-keyed: fill needs an unlocked session; UI/agent
    // reveals consume a one-time item permit. EVERY locker.* sealed entity is
    // gated (#873) — a sidecar reveal spends its owning item's permit, and an
    // unresolvable owner is gated on the requested id (which no permit names)
    // so "row missing" and "no permit" refuse identically.
    let owningItemId: string | null = null;
    if (ref.schema === "locker") {
      owningItemId = this.lockerOwningItemId(
        request.entity,
        ref.physical,
        entityId
      );
      try {
        this.enforceLockerReveal(
          request,
          owningItemId ?? entityId,
          context !== undefined
        );
      } catch (error) {
        return deny(
          error instanceof Error
            ? error.message
            : "Locker authentication required"
        );
      }
      if (owningItemId === null)
        return deny(`no revealable ${request.entity} row ${entityId}`);
    }
    const access = evaluateAccess(
      this.db.vault,
      identity,
      ref.schema,
      ref.table,
      "reveal",
      request.purpose
    );
    if (access.decision === "deny") return deny(access.failing, access.grantId);
    const pk = pkColumn(this.db.vault, ref.physical);
    // The grant's row filter clamps WHICH items are revealable — how a
    // connector's grant names its specific locker items (#293 dec 8).
    const rowFilter = compileFilters(
      this.db.vault,
      ref.physical,
      access.rowFilter,
      nowIso()
    );
    const select = columns.map((c) => `"${c}"`).join(", ");
    const row = this.db.vault
      .prepare(
        `SELECT ${select} FROM "${ref.physical}" WHERE "${pk}" = ? AND ${rowFilter.where}`
      )
      .get(entityId, ...rowFilter.params) as
      | Record<string, unknown>
      | undefined;
    if (!row) return deny(`no revealable ${request.entity} row ${entityId}`);
    const values: Record<string, string | null> = {};
    let unsealedAny = false;
    for (const col of columns) {
      const value = row[col];
      if (value == null || value === "") {
        values[col] = null;
      } else if (isSealedValue(value)) {
        values[col] = unsealValue(
          this.db.sealKey,
          sealAad(ref.physical, col, entityId),
          value
        );
        unsealedAny = true;
      } else {
        values[col] = String(value); // pre-seal legacy plaintext
      }
    }
    // A successful unseal proves this key sealed this vault's secrets, so
    // stamp the fingerprint a pre-#298 vault never recorded.
    if (unsealedAny) stampSealKeyFingerprint(this.db.vault, this.db.sealKey);
    const receiptId = writeReceipt(this.db.audit, {
      grantId: access.grantId,
      invocationId: null,
      action: "reveal",
      objectType: request.entity,
      objectId: entityId,
      purpose: request.purpose,
      decision: "allow",
      detail: {
        columns,
        // A sidecar reveal names the row it opened AND the item whose permit
        // it spent, so "what looked at my secrets" stays answerable per item.
        ...(owningItemId !== null && owningItemId !== entityId
          ? { itemId: owningItemId }
          : {}),
        ...(request.alias === undefined ? {} : { alias: request.alias }),
        ...(context ? { context } : {}),
      },
    });
    return { values, receiptId };
  }

  /**
   * The owner's whole-model SQL read (the assistant's primary tool): one
   * read-only statement over the full canonical schema. Owner-device only — no
   * consent clamping, because there is no third party — but every run is
   * receipted like any other read.
   */
  sql(cred: Credential, request: VaultSqlRequest): VaultSqlResult {
    const identity = this.identify(cred);
    const purpose = request.purpose ?? "owner-assistant";
    if (identity.kind !== "owner-device") {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: null,
        invocationId: null,
        action: "read",
        objectType: "vault.sql",
        objectId: null,
        purpose,
        decision: "deny",
        detail: { failing: "whole-model sql is owner-only" },
      });
      throw new GatewayError(
        "access",
        `deny (receipt ${receiptId}): whole-model sql is the owner's surface`
      );
    }
    const result = runReadOnlySql(
      this.db,
      request.sql,
      request.maxRows ?? VAULT_SQL_DEFAULT_ROWS
    );
    const receiptId = writeReceipt(this.db.audit, {
      grantId: null,
      invocationId: null,
      action: "read",
      objectType: "vault.sql",
      objectId: null,
      purpose,
      decision: "allow",
      detail: {
        sql:
          request.sql.length > 400
            ? `${request.sql.slice(0, 400)}…`
            : request.sql,
        rowCount: result.totalRows,
        durationMs: result.durationMs,
      },
    });
    return { ...result, receiptId };
  }

  /**
   * Consent-checked full-text search: matching runs inside SQLite's FTS5 shadow
   * tables (schema/fts.ts), so a caller gets its LIMIT of ranked matches
   * instead of a whole table to grep.
   */
  search(cred: Credential, rawRequest: SearchRequest): SearchResult {
    const identity = this.identify(cred);
    const request = {
      ...rawRequest,
      purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
    };
    const result = searchEntity(this.db, identity, request);
    // Search-miss prioritization (#299): owner-plane only, deduped against
    // open requests, so enrichers drain the queue first.
    if (result.rows.length === 0 && identity.kind === "owner-device") {
      const open = this.db.vault
        .prepare(
          `SELECT 1 AS x FROM enrich_request
            WHERE target_type = ? AND reason = 'search-miss' AND detail = ? AND drained_at IS NULL`
        )
        .get(request.entity, request.query);
      if (!open) {
        this.db.vault
          .prepare(
            `INSERT INTO enrich_request (request_id, target_type, target_id, reason, detail, requested_at, drained_at)
             VALUES (?, ?, NULL, 'search-miss', ?, ?, NULL)`
          )
          .run(uuidv7(), request.entity, request.query, nowIso());
      }
    }
    return result;
  }

  /**
   * The card resolver (#272): (type, id) refs → minimal renderable cards under
   * the resolvable-if-linked rule, so a projection renders what the owner
   * linked without holding read scopes on the foreign domain. Receipted per
   * batch; per-ref denials come back as 'denied' cards, never exceptions.
   */
  resolveRefs(cred: Credential, request: RefRequest): ResolveResult {
    const identity = this.identify(cred);
    return resolveRefCards(this.db.vault, this.db.audit, identity, request);
  }

  /**
   * The consented change feed (data triggers' outbox). Every watched entity is
   * consent-checked for read under the declared purpose — one denied entity
   * denies the whole pull (fail closed, receipted). A `null` cursor bootstraps
   * to the watermark, so a fresh watcher never replays history it was not
   * granted while it happened.
   */
  changes(cred: Credential, rawRequest: ChangesRequest): ChangesResult {
    const identity = this.identify(cred);
    const request = {
      ...rawRequest,
      purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
    };
    if (request.entities.length === 0) {
      throw new GatewayError(
        "contract",
        "changes needs at least one entity to watch"
      );
    }
    for (const entity of request.entities) {
      const ref = resolveEntity(entity, this.db.vault);
      const access = ref
        ? evaluateAccess(
            this.db.vault,
            identity,
            ref.schema,
            ref.table,
            "read",
            request.purpose
          )
        : ({
            decision: "deny",
            failing: `unknown entity ${entity}`,
            grantId: null,
          } as const);
      if (access.decision === "deny") {
        const receiptId = writeReceipt(this.db.audit, {
          grantId: access.grantId,
          invocationId: null,
          action: "read",
          objectType: "access.provenance",
          objectId: null,
          purpose: request.purpose,
          decision: "deny",
          detail: { failing: access.failing, entity },
        });
        throw new GatewayError(
          "access",
          `deny (receipt ${receiptId}): ${access.failing}`
        );
      }
    }
    const watermarkRow = this.db.audit
      .prepare(
        "SELECT prov_id FROM access_provenance ORDER BY prov_id DESC LIMIT 1"
      )
      .get() as { prov_id: string } | undefined;
    const watermark = watermarkRow?.prov_id ?? "";
    let changes: ChangeEntry[] = [];
    let cursor = request.cursor ?? watermark;
    if (request.cursor !== null) {
      const limit = Math.min(Math.max(request.limit ?? 200, 1), 500);
      const placeholders = request.entities.map(() => "?").join(", ");
      // Demo writes never reach the feed (#290): data triggers ride this
      // outbox, and scenario data must not fire automations.
      const rows = this.db.audit
        .prepare(
          `SELECT prov_id, entity_type, entity_id, prov_activity, agent_kind, occurred_at
             FROM access_provenance
            WHERE prov_id > ? AND entity_type IN (${placeholders})
              AND prov_activity != '${SEED_DEMO_ACTIVITY}'
            ORDER BY prov_id ASC LIMIT ${limit}`
        )
        .all(request.cursor, ...request.entities) as {
        prov_id: string;
        entity_type: string;
        entity_id: string;
        prov_activity: string;
        agent_kind: ChangeEntry["agentKind"];
        occurred_at: string;
      }[];
      changes = rows.map((r) => ({
        provId: r.prov_id,
        entity: r.entity_type,
        entityId: r.entity_id,
        activity: r.prov_activity,
        agentKind: r.agent_kind,
        occurredAt: r.occurred_at,
      }));
      const last = changes.at(-1);
      // On empty pull jump to the pre-select watermark (captured before the
      // range scan): nothing ≤ it stays unmatched-but-matching.
      if (last) cursor = last.provId;
      else if (watermark > cursor) cursor = watermark;
    }
    const receiptId = writeReceipt(this.db.audit, {
      grantId: null,
      invocationId: null,
      action: "read",
      objectType: "access.provenance",
      objectId: null,
      purpose: request.purpose,
      decision: "allow",
      detail: { entities: request.entities, rowCount: changes.length },
    });
    return { changes, cursor, receiptId };
  }

  /**
   * Grant plane's one seam into ordinary writes (#825 G-edit). Grant constrains the named audience, never the issuing vault.
   * Re-derive refusal from THIS actor's grants — a mixed edit+view container's folded refusal would miss a view-only member.
   */
  private shareGrantRefusal(
    identity: Identity,
    rawRequest: InvokeRequest
  ): { reason: string; containerId: string; actorPartyId: string } | undefined {
    const actorPartyId = identity.partyId;
    if (!actorPartyId) return undefined;
    const owner = this.db.vault
      .prepare("SELECT self_party_id FROM core_vault LIMIT 1")
      .get() as { self_party_id: string | null } | undefined;
    if (!owner?.self_party_id || owner.self_party_id === actorPartyId)
      return undefined;
    const route = routeShareGrantEdit(this.db.vault, {
      command: rawRequest.command,
      commandInput: rawRequest.input,
    });
    if (!route) return undefined;
    const actorGrants = route.grants.filter((grant) =>
      resolveAudienceParties(this.db.vault, grant.audience).includes(
        actorPartyId
      )
    );
    if (actorGrants.length === 0) return undefined;
    const reason = shareGrantEditRefusal(route, actorGrants);
    if (!reason) return undefined;
    return { reason, containerId: route.containerId, actorPartyId };
  }

  /** The only write path (rule R04). */
  invoke(cred: Credential, rawRequest: InvokeRequest): InvokeOutcome {
    const identity = this.identify(cred);
    // BEFORE the commons rail: a refusal here is about the STANDING GRANT,
    // not something the rail should carry to the steward.
    const refused = this.shareGrantRefusal(identity, rawRequest);
    if (refused) {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: null,
        invocationId: rawRequest.invocationId ?? null,
        action: `act ${rawRequest.command}`,
        objectType: "share.grant",
        objectId: refused.containerId,
        purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
        decision: "deny",
        detail: {
          failing: refused.reason,
          actorPartyId: refused.actorPartyId,
        },
      });
      return { status: "denied", receiptId, reason: refused.reason };
    }
    const grant = commonsGrantForCommand(
      this.db.vault,
      rawRequest.command,
      rawRequest.input
    );
    if (!grant) return this.invokeCore(identity, rawRequest);
    if (!isCommonsCommandActable(grant.containerType, rawRequest.command)) {
      const reason = `command ${rawRequest.command} is not declared for ${grant.containerType}`;
      const receiptId = writeReceipt(this.db.audit, {
        grantId: grant.grantId,
        invocationId: rawRequest.invocationId ?? null,
        action: `act ${rawRequest.command}`,
        objectType: "share.commons",
        objectId: grant.grantId,
        purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
        decision: "deny",
        detail: { failing: reason },
      });
      return { status: "denied", receiptId, reason };
    }
    const local = this.db.vault
      .prepare("SELECT vault_id, self_party_id FROM core_vault LIMIT 1")
      .get() as { vault_id: string; self_party_id: string | null } | undefined;
    if (!local?.self_party_id) return this.invokeCore(identity, rawRequest);
    const grantActor = this.db.vault
      .prepare(
        `SELECT b.party_id FROM share_party_vault_binding b
         JOIN social_circle_member m ON m.party_id = b.party_id
         JOIN share_commons_member_state s
           ON s.grant_id = ? AND s.party_id = b.party_id AND s.status = 'current'
         WHERE b.vault_id = ? AND b.revoked_at IS NULL
           AND m.circle_id = ? LIMIT 1`
      )
      .get(grant.grantId, local.vault_id, grant.circleId) as
      | { party_id: string }
      | undefined;
    const actorPartyId = grantActor?.party_id ?? local.self_party_id;
    if (grant.stewardPartyId !== actorPartyId) {
      // Installed apps are the foreground door; only an enrolled agent is a
      // background executor.
      const background = cred.kind === "agent";
      const stewardLabel = commonsStewardDeviceLabel(
        this.db.vault,
        grant.stewardPartyId
      );
      const reason = background
        ? "commons automations execute only at the steward's seat"
        : `waiting for ${stewardLabel}`;
      if (!background)
        queueCommonsIntent({
          seat: this.db.vault,
          ...(rawRequest.intentId ? { intentId: rawRequest.intentId } : {}),
          grantId: grant.grantId,
          actorPartyId,
          command: rawRequest.command,
          commandInput: rawRequest.input,
          stewardLabel,
          now: nowIso(),
        });
      if (!background) {
        if (this.activeBatchCommonsIntentGrantIds)
          this.activeBatchCommonsIntentGrantIds.push(grant.grantId);
        else this.emitCommonsIntentQueued(grant.grantId);
      }
      const receiptId = writeReceipt(this.db.audit, {
        grantId: grant.grantId,
        invocationId: rawRequest.invocationId ?? null,
        action: `act ${rawRequest.command}`,
        objectType: "share.commons",
        objectId: grant.grantId,
        purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
        decision: "deny",
        detail: { failing: reason, actorPartyId },
      });
      return { status: "denied", receiptId, reason };
    }
    if (!this.db.vault.isTransaction && !this.db.audit.isTransaction) {
      const [settled] = this.invokeBatchSettled([
        () => this.invoke(cred, rawRequest),
      ]);
      if (!settled)
        throw new Error("commons invocation batch returned no result");
      if (!settled.ok) {
        if (settled.error instanceof CommonsMaxSizeError) {
          const receiptId = writeReceipt(this.db.audit, {
            grantId: grant.grantId,
            invocationId: rawRequest.invocationId ?? null,
            action: `act ${rawRequest.command}`,
            objectType: "share.commons",
            objectId: grant.grantId,
            purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
            decision: "deny",
            detail: { failing: settled.error.message, actorPartyId },
          });
          return {
            status: "denied",
            receiptId,
            reason: settled.error.message,
          };
        }
        throw settled.error;
      }
      return settled.value;
    }
    const outcome = this.invokeCore(identity, rawRequest);
    const executed =
      outcome.status === "executed" || outcome.status === "replayed";
    if (executed)
      assertCommonsWithinMax(this.db.vault, local.vault_id, grant.grantId);
    const append = this.db.vault.isTransaction
      ? appendCommonsOperationInTransaction
      : appendCommonsOperation;
    try {
      append({
        steward: this.db.vault,
        grantId: grant.grantId,
        actorPartyId,
        kind: rawRequest.command.includes("delete") ? "delete" : "command",
        command: rawRequest.command,
        input: rawRequest.input,
        outcome: executed ? "executed" : "refused",
        ...(executed || !outcome.reason ? {} : { reason: outcome.reason }),
        now: nowIso(),
      });
    } catch (error) {
      throw markCommonsOperationError(error);
    }
    let reconciledGrantIds: string[] = [];
    if (executed) {
      try {
        reconciledGrantIds = sequenceCommonsCircleCommandInTransaction({
          steward: this.db.vault,
          primaryGrantId: grant.grantId,
          actorPartyId,
          command: rawRequest.command,
          commandInput: rawRequest.input,
          now: nowIso(),
        });
      } catch (error) {
        throw markCommonsOperationError(error);
      }
    }
    if (executed)
      for (const reconciledGrantId of reconciledGrantIds)
        assertCommonsWithinMax(
          this.db.vault,
          local.vault_id,
          reconciledGrantId
        );
    const changedGrantIds = new Set([grant.grantId, ...reconciledGrantIds]);
    if (this.activeBatchCommonsGrantIds)
      this.activeBatchCommonsGrantIds.push(...changedGrantIds);
    else
      for (const changedGrantId of changedGrantIds)
        this.emitCommonsCommandSequenced(changedGrantId);
    return outcome;
  }

  /** Explicit Commons rail already authorized and sequenced the command. */
  invokeCommonsCanonical(
    cred: Credential,
    rawRequest: InvokeRequest,
    options: { idSeed?: string } = {}
  ): InvokeOutcome {
    return this.invokeCore(this.identify(cred), rawRequest, options.idSeed);
  }

  private invokeCore(
    identity: Identity,
    rawRequest: InvokeRequest,
    deterministicIdSeed?: string
  ): InvokeOutcome {
    // Purposes are off the critical path (#306 decision 4): a caller naming
    // none rides the default, and the journal records what applied.
    const request = {
      ...rawRequest,
      purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
    };
    // The demo register is the OWNER loading a scenario: a granted caller
    // marking real-looking rows purgeable would be an integrity hole.
    if (request.demo && identity.kind !== "owner-device") {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: null,
        invocationId: null,
        action: `act ${request.command}`,
        objectType: "agent.command",
        objectId: null,
        purpose: request.purpose,
        decision: "deny",
        detail: { failing: "demo register is owner-only" },
      });
      return {
        status: "denied",
        receiptId,
        reason: "demo register is owner-only",
      };
    }
    const command = lookupCommand(this.db.vault, request.command);
    if (!command || !this.commands.has(request.command)) {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: null,
        invocationId: null,
        action: `act ${request.command}`,
        objectType: "agent.command",
        objectId: null,
        purpose: request.purpose,
        decision: "deny",
        detail: { failing: "unknown command" },
      });
      return {
        status: "denied",
        receiptId,
        reason: `unknown command ${request.command}`,
      };
    }

    const access = evaluateAccess(
      this.db.vault,
      identity,
      command.owner_schema,
      request.command.split(".")[1] ?? "",
      "act",
      request.purpose
    );
    if (access.decision === "deny") {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: access.grantId,
        invocationId: null,
        action: `act ${request.command}`,
        objectType: "agent.command",
        objectId: command.command_id,
        purpose: request.purpose,
        decision: "deny",
        // A refusal is attributed too (#599 decisions 7–8): "the assistant,
        // acting for Sid, was refused" is the row an owner needs.
        detail: {
          failing: access.failing,
          ...actingOwnerDetail(identity, request),
        },
      });
      return { status: "denied", receiptId, reason: access.failing };
    }

    if (request.intentId && identity.kind === "app") {
      const intent = this.db.vault
        .prepare(
          `SELECT outcome.device_id, app.app_id AS enrolled_app_id
             FROM replica_intent_outcome AS outcome
             JOIN access_app AS app ON app.name = outcome.app_id
            WHERE outcome.intent_id = ?`
        )
        .get(request.intentId) as
        | { device_id: string; enrolled_app_id: string }
        | undefined;
      if (
        !intent ||
        !request.intentDeviceId ||
        intent.device_id !== request.intentDeviceId ||
        intent.enrolled_app_id !== identity.callerId
      ) {
        throw new GatewayError(
          "contract",
          `replica intent ${request.intentId} is not owned by this device and app`
        );
      }
    }

    const invocationAlreadyExists = request.invocationId
      ? assertInvocationIdentity(
          this.db,
          request.invocationId,
          command.command_id,
          identity.callerId,
          access.grantId
        )
      : false;
    const replayed = request.invocationId
      ? replayInvocation(this.db, request.invocationId, {
          deferCommitSettlement: this.activeBatchInvocationIds !== undefined,
        })
      : null;
    if (replayed) return this.trackBatchInvocation(replayed);

    // Confirmation routing (#306 decision 2, amending #294 decision 4): risk
    // never parks; only `confirm: true` does, for EVERY non-owner caller.
    const sealedInput = this.commands.get(request.command)?.sealedInput ?? [];
    const capability = this.db.vault
      .prepare(
        `SELECT requires_confirmation FROM agent_capability WHERE command_id = ?`
      )
      .get(command.command_id) as { requires_confirmation: number } | undefined;
    if (
      identity.kind !== "owner-device" &&
      capability?.requires_confirmation === 1
    ) {
      const invocationId = request.invocationId ?? uuidv7();
      if (!invocationAlreadyExists) {
        insertInvocation(
          this.db,
          { ...request, invocationId },
          command,
          identity,
          access.grantId,
          "proposed",
          invocationId,
          sealedInput
        );
      }
      const parkedAt = nowIso();
      const reason = `${command.name} requires owner confirmation (loud on purpose)`;
      saveDurableParkedPayload(this.db, {
        invocationId,
        ...(request.intentId ? { intentId: request.intentId } : {}),
        identity,
        request: { ...request, invocationId },
        grantId: access.grantId,
        commandId: command.command_id,
        commandName: command.name,
        reason,
        parkedAt,
      });
      this.ringDecisionChanged(true);
      return {
        status: "parked",
        invocationId,
        reason,
      };
    }

    const invocationId =
      request.invocationId ??
      insertInvocation(
        this.db,
        request,
        command,
        identity,
        access.grantId,
        "proposed",
        undefined,
        sealedInput
      );
    if (request.invocationId && !invocationAlreadyExists) {
      insertInvocation(
        this.db,
        { ...request, invocationId },
        command,
        identity,
        access.grantId,
        "proposed",
        invocationId,
        sealedInput
      );
    }
    return this.trackBatchInvocation(
      runContractAndExecute(
        this.db,
        this.commands,
        identity,
        request,
        command,
        access,
        invocationId,
        undefined,
        this.deps.onProvenanceCommitted,
        {
          deferCommitSettlement: this.activeBatchInvocationIds !== undefined,
          deferReplicaNotify: this.activeBatchInvocationIds !== undefined,
          ...(deterministicIdSeed ? { deterministicIdSeed } : {}),
        }
      )
    );
  }

  /** Owner decision on a parked invocation (confirmation routing duty). */
  confirm(
    cred: Credential,
    invocationId: string,
    approve: boolean
  ): InvokeOutcome {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError(
        "access",
        "only the owner confirms parked invocations"
      );
    // Journal denial commits before vault settlement: any retry, even an
    // accidental approve, finishes the original denial.
    const priorDenial = readDurableParkedDenial(this.db, invocationId);
    if (priorDenial) {
      const pending = readDurableParkedPayload(this.db, invocationId);
      if (pending) {
        settleDurableParkedPayload(
          this.db,
          invocationId,
          pending.intentId
            ? {
                intentId: pending.intentId,
                outcome: {
                  status: "denied",
                  invocationId,
                  reason: priorDenial.reason,
                },
              }
            : undefined
        );
        this.ringDecisionChanged(false);
      }
      return { status: "denied", ...priorDenial };
    }
    const entry = readDurableParkedPayload(this.db, invocationId);
    if (!entry)
      throw new GatewayError(
        "contract",
        `no parked invocation ${invocationId}`
      );
    const replayed = replayInvocation(this.db, invocationId);
    if (replayed?.status === "replayed") {
      settleDurableParkedPayload(
        this.db,
        invocationId,
        entry.intentId
          ? {
              intentId: entry.intentId,
              outcome: { status: "executed", invocationId },
            }
          : undefined
      );
      this.ringDecisionChanged(false);
      return replayed;
    }
    const command = lookupCommand(this.db.vault, entry.commandName);
    if (
      !command ||
      command.command_id !== entry.commandId ||
      !this.commands.has(entry.commandName)
    ) {
      throw new GatewayError(
        "contract",
        `handler missing for parked command ${entry.commandName}`
      );
    }
    // A durable confirmation may outlive its grant — re-check at decision
    // time or a revoked grant could still execute.
    const decisionAt = nowIso();
    const grantStillActive =
      entry.grantId === null ||
      this.db.vault
        .prepare(
          `SELECT 1 AS active FROM access_grant
            WHERE grant_id = ? AND status = 'active' AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)`
        )
        .get(entry.grantId, decisionAt) !== undefined;
    if (!approve || !grantStillActive) {
      const denialReason = approve
        ? "consent grant no longer active"
        : "owner denied confirmation";
      const denial = recordDurableParkedDenial(this.db, {
        payload: entry,
        confirmedBy: owner.partyId,
        confirmedAt: decisionAt,
        reason: denialReason,
      });
      settleDurableParkedPayload(
        this.db,
        invocationId,
        entry.intentId
          ? {
              intentId: entry.intentId,
              outcome: {
                status: "denied",
                invocationId,
                reason: denialReason,
              },
            }
          : undefined
      );
      this.ringDecisionChanged(false);
      return { status: "denied", ...denial };
    }
    const access: AccessAllow = {
      decision: "allow",
      grantId: entry.grantId,
      rowFilter: [],
      fieldMask: null,
    };
    const outcome = runContractAndExecute(
      this.db,
      this.commands,
      entry.identity,
      entry.request,
      command,
      access,
      invocationId,
      { confirmedBy: owner.partyId, confirmedAt: nowIso() },
      this.deps.onProvenanceCommitted
    );
    settleDurableParkedPayload(
      this.db,
      invocationId,
      entry.intentId
        ? {
            intentId: entry.intentId,
            outcome: {
              status:
                outcome.status === "executed" || outcome.status === "replayed"
                  ? "executed"
                  : outcome.status,
              invocationId,
              ...("reason" in outcome ? { reason: outcome.reason } : {}),
            },
          }
        : undefined
    );
    this.ringDecisionChanged(false);
    return outcome;
  }

  /** Owner-only, instant and total. */
  revokeGrant(cred: Credential, grantId: string): RevocationResult {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner revokes grants");
    const result = revokeGrantCascade(this.db, owner, grantId, (revoked) => {
      let invocationIds: string[];
      this.db.vault.exec("BEGIN IMMEDIATE");
      let replicaCommit!: ReturnType<typeof beginReplicaCommit>;
      try {
        replicaCommit = beginReplicaCommit(this.db.vault);
        const parked = listDurableParkedPayloads(this.db).filter(
          (entry) => entry.grantId === revoked
        );
        invocationIds = deleteDurableParkedPayloadsForGrant(this.db, revoked);
        for (const entry of parked) {
          if (!entry.intentId) continue;
          transitionReplicaIntentOutcomeInTransaction(
            this.db.vault,
            entry.intentId,
            {
              status: "failed",
              invocationId: entry.invocationId,
              reason: "consent grant revoked while awaiting confirmation",
            }
          );
        }
        endReplicaCommit(this.db.vault, replicaCommit);
        this.db.vault.exec("COMMIT");
      } catch (error) {
        this.db.vault.exec("ROLLBACK");
        throw error;
      }
      for (const invocationId of invocationIds) {
        setInvocationStatus(this.db, invocationId, "failed");
      }
      return invocationIds.length;
    });
    // A retained band's write trio goes with the app's access.
    if (result.extRetained.length > 0 && result.appId) {
      this.deregisterExtCommands(result.appId);
    }
    this.ringProvenance();
    if (result.parkedDropped > 0) this.ringDecisionChanged(false);
    return result;
  }

  sweep(cred: Credential): SweepResult {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner runs sweeps");
    const result = sweepLifecycle(this.db, owner);
    // Cheap, fully rebuildable; rides the standing clock.
    recomputeDuplicateClusters(this.db.vault);
    // AFTER the recompute above (#724): a regrouped sweep feeds this pass's
    // 'similar' memories. Face clusters read what the faces sweep wrote (#724).
    rebuildMemories(this.db.vault);
    rebuildFaceClusters(this.db.vault);
    // Seed jobs for old video/audio/PDF content and clear vanished ownership,
    // so a backstop looking for NULL leases can resume immediately.
    releaseExpiredEnrichmentLeases(this.db.vault);
    drainSatisfiedEnrichmentRequests(this.db.vault);
    queueMissingDeviceEnrichmentBacklog(this.db.vault, {
      newId: () => uuidv7(),
      requestedAt: nowIso(),
      limit: 100,
    });
    this.ringProvenance();
    // Sweeps commit outside the command path; wake replica SSE streams at the
    // same post-commit boundary.
    notifyReplicaCommit(this.db.vault);
    return result;
  }

  checkpoint(cred: Credential): { vault: string } {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner checkpoints");
    return checkpointVault(this.db);
  }

  backup(cred: Credential, destDir: string): BackupResult {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner backs up");
    return backupVault(this.db, destDir);
  }

  /**
   * The ext band (#286): diff-apply an app's declared extension tables to the
   * live band, keep the typed write trio registered exactly when the band is
   * non-empty, and receipt the change. Owner-only — DDL comes from the manifest
   * through the host, never from the app.
   */
  applyAppExt(
    cred: Credential,
    appId: string,
    tables: ExtTableSpec[]
  ): ExtApplyOutcome & {
    receiptId: string;
  } {
    const owner = this.requireOwner(cred, "only the owner applies ext bands");
    const outcome = applyExtBand(this.db, appId, tables, "live");
    if (tables.length > 0) this.registerExtCommands(appId);
    else this.deregisterExtCommands(appId);
    const receiptId = this.receiptExt(owner, appId, "access.app_ext_apply", {
      band: "live",
      ...outcome,
    });
    return { ...outcome, receiptId };
  }

  /**
   * First call seeds from live rows; later calls diff-apply and keep draft
   * rows. `reset` drops the band first for a fresh live snapshot.
   */
  seedAppExtDraft(
    cred: Credential,
    appId: string,
    tables: ExtTableSpec[],
    opts?: { reset?: boolean }
  ): ExtApplyOutcome & {
    receiptId: string;
  } {
    const owner = this.requireOwner(cred, "only the owner seeds draft bands");
    if (opts?.reset) dropExtBand(this.db, appId, "draft");
    const outcome = seedExtDraft(this.db, appId, tables);
    const receiptId = this.receiptExt(
      owner,
      appId,
      "access.app_ext_draft_seed",
      {
        band: "draft",
        ...outcome,
      }
    );
    return { ...outcome, receiptId };
  }

  dropAppExtDraft(
    cred: Credential,
    appId: string
  ): { dropped: string[]; receiptId: string } {
    const owner = this.requireOwner(cred, "only the owner drops draft bands");
    const dropped = dropExtBand(this.db, appId, "draft");
    const receiptId = this.receiptExt(
      owner,
      appId,
      "access.app_ext_draft_drop",
      { dropped }
    );
    return { dropped, receiptId };
  }

  /** Uninstall default: data retained, commands deregistered, draft gone. */
  retainAppExt(
    cred: Credential,
    appId: string
  ): { retained: string[]; receiptId: string } {
    const owner = this.requireOwner(cred, "only the owner retires ext bands");
    const retained = retainExtBand(this.db, appId);
    this.deregisterExtCommands(appId);
    const receiptId = this.receiptExt(owner, appId, "access.app_ext_retain", {
      retained,
    });
    return { retained, receiptId };
  }

  /** Owner purge: both bands dropped, registry rows gone, refs swept. */
  purgeAppExt(
    cred: Credential,
    appId: string
  ): { purged: string[]; receiptId: string } {
    const owner = this.requireOwner(cred, "only the owner purges ext bands");
    const purged = purgeExtBand(this.db, appId);
    this.deregisterExtCommands(appId);
    const receiptId = this.receiptExt(owner, appId, "access.app_ext_purge", {
      purged,
    });
    return { purged, receiptId };
  }

  registerAllExtCommands(): void {
    for (const appId of extAppIds(this.db.vault))
      this.registerExtCommands(appId);
  }

  private registerExtCommands(appId: string): void {
    for (const def of extCommandDefinitions(appId)) this.registerCommand(def);
  }

  private deregisterExtCommands(appId: string): void {
    for (const name of extCommandNames(appId)) this.deregisterCommand(name);
  }

  deregisterCommand(name: string): void {
    const existing = lookupCommand(this.db.vault, name);
    if (existing) {
      this.db.vault
        .prepare("DELETE FROM agent_capability WHERE command_id = ?")
        .run(existing.command_id);
      this.db.vault
        .prepare("DELETE FROM agent_command WHERE command_id = ?")
        .run(existing.command_id);
    }
    this.commands.delete(name);
  }

  private requireOwner(cred: Credential, refusal: string): Identity {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", refusal);
    return owner;
  }

  private receiptExt(
    owner: Identity,
    appId: string,
    action: string,
    detail: Record<string, unknown>
  ): string {
    return writeReceipt(this.db.audit, {
      grantId: null,
      invocationId: null,
      action: `act ${action}`,
      objectType: "access.app",
      objectId: appId,
      purpose: null,
      decision: "allow",
      detail: { ...detail, by: owner.partyId },
    });
  }

  /**
   * Purge demo data (#290), whole vault or one app's scenario. Owner-only,
   * receipted; rows a non-demo FK still holds are reported blocked, never
   * force-deleted.
   */
  purgeDemo(cred: Credential, appId?: string): DemoPurgeResult {
    const owner = this.requireOwner(cred, "only the owner purges demo data");
    const result = purgeDemoRows(this.db, owner, appId);
    this.ringProvenance();
    return result;
  }

  demoStatus(cred: Credential): { appId: string; rows: number }[] {
    this.requireOwner(cred, "only the owner inspects demo status");
    return demoStatus(this.db);
  }

  /**
   * File-drop customs (#290): stage a dropped file into a reviewable draft
   * batch. Nothing touches a domain table until the owner publishes.
   */
  stageImportFile(
    cred: Credential,
    options: StageFileOptions
  ): StageFileResult {
    const owner = this.requireOwner(cred, "only the owner imports (v0)");
    return stageFile(this.db, owner, options);
  }

  publishImport(cred: Credential, batchId: string): PublishResult {
    const owner = this.requireOwner(
      cred,
      "only the owner publishes imports (v0)"
    );
    return publishBatch(
      this.db,
      owner,
      batchId,
      PUBLISHERS,
      this.deps.onProvenanceCommitted
    );
  }

  discardImport(cred: Credential, batchId: string): { receiptId: string } {
    const owner = this.requireOwner(
      cred,
      "only the owner discards imports (v0)"
    );
    return discardBatch(this.db, owner, batchId);
  }

  /**
   * Blob ingress (#296): hash raw bytes into the local CAS and record a staging
   * row. NOT a vault write — no receipt, no content item; the command that
   * claims the sha is the write and mints the receipt. Unclaimed stages sweep
   * after the TTL. Any caller that may act can stage; claiming is where consent
   * bites.
   */
  stageBlob(
    cred: Credential,
    options: Omit<StageBlobOptions, "stagedBy">
  ): StagedBlob {
    const identity = this.identify(cred);
    if (!identity.mayAct) {
      throw new GatewayError("access", "readonly devices stage nothing");
    }
    return stageBlobBytes(this.db, { ...options, stagedBy: identity.callerId });
  }

  /**
   * Blob egress (#296): consent (read on core.content_item, receipted) plus the
   * DERIVED reachability rule — bytes serve only when some edge in the model
   * claims them. Returns metadata only; the transport streams from custody, so
   * Range never crosses this boundary.
   */
  resolveBlob(
    cred: Credential,
    contentId: string,
    options: { variant?: string; purpose?: string } = {}
  ): BlobResolveOutcome & { receiptId?: string } {
    const identity = this.identify(cred);
    const purpose = options.purpose ?? "dpv:ServiceProvision";
    const access = evaluateAccess(
      this.db.vault,
      identity,
      "core",
      "content_item",
      "read",
      purpose
    );
    if (access.decision === "deny") {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: access.grantId,
        invocationId: null,
        action: "read",
        objectType: "core.content_item",
        objectId: contentId,
        purpose,
        decision: "deny",
        detail: { failing: access.failing, surface: "blob" },
      });
      throw new GatewayError(
        "access",
        `deny (receipt ${receiptId}): ${access.failing}`
      );
    }
    const outcome = resolveServableBlob(
      this.db.vault,
      contentId,
      options.variant
    );
    const receiptId = writeReceipt(this.db.audit, {
      grantId: access.grantId,
      invocationId: null,
      action: "read",
      objectType: "core.content_item",
      objectId: contentId,
      purpose,
      decision: outcome.status === "ok" ? "allow" : "deny",
      detail: {
        surface: "blob",
        variant: options.variant ?? "original",
        ...(outcome.status === "ok" ? {} : { failing: outcome.status }),
      },
    });
    return { ...outcome, receiptId };
  }

  /**
   * Agent content access (#299 §2, the #296 §7 seam). Structural rule:
   * DERIVATIVES EGRESS, NEVER ORIGINALS — the surface spells only `thumb`,
   * `preview` and `text`. Consent is the same read evaluation the blob routes
   * run, and every fetch, allow or deny, is receipted.
   */
  async contentForAgent(
    cred: Credential,
    request: {
      contentId: string;
      variant: string;
      maxBytes?: number;
      purpose?: string;
    }
  ): Promise<AgentContentOutcome & { receiptId: string }> {
    const identity = this.identify(cred);
    const purpose = request.purpose ?? "dpv:ServiceProvision";
    if (
      !(AGENT_CONTENT_VARIANTS as readonly string[]).includes(request.variant)
    ) {
      throw new GatewayError(
        "access",
        `variant "${request.variant}" is not agent-readable: ${AGENT_CONTENT_VARIANTS.join(", ")}`
      );
    }
    const access = evaluateAccess(
      this.db.vault,
      identity,
      "core",
      "content_item",
      "read",
      purpose
    );
    if (access.decision === "deny") {
      const receiptId = writeReceipt(this.db.audit, {
        grantId: access.grantId,
        invocationId: null,
        action: "read",
        objectType: "core.content_item",
        objectId: request.contentId,
        purpose,
        decision: "deny",
        detail: {
          failing: access.failing,
          surface: "agent-content",
          variant: request.variant,
        },
      });
      throw new GatewayError(
        "access",
        `deny (receipt ${receiptId}): ${access.failing}`
      );
    }
    const outcome = await resolveAgentContent(
      this.db,
      request.contentId,
      request.variant as AgentContentVariant,
      request.maxBytes
    );
    const receiptId = writeReceipt(this.db.audit, {
      grantId: access.grantId,
      invocationId: null,
      action: "read",
      objectType: "core.content_item",
      objectId: request.contentId,
      purpose,
      decision: outcome.status === "ok" ? "allow" : "deny",
      detail: {
        surface: "agent-content",
        variant: request.variant,
        by: identity.callerId,
        ...(outcome.status === "ok" ? {} : { failing: outcome.status }),
      },
    });
    return { ...outcome, receiptId };
  }

  /** Standing duty: blob replication + reconciliation (#296). Pushes local bytes the remote lacks, deletes unclaimed orphans, reports shas missing from BOTH tiers — integrity errors surface, never papered over. */
  async sweepBlobs(
    cred: Credential,
    options?: {
      skipOrphanDelete?: boolean;
      extraLiveRoots?: ReadonlySet<string>;
      graceWindowMs?: number;
    }
  ): Promise<ReconcileResult & { receiptId: string }> {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner sweeps blob custody");
    // Archive segments are claimed by the manifest chain / ledger (#367,
    // #438), not by content rows — a pruned segment is the only copy of its
    // rows. Without these unions reconcile deletes them.
    const live = liveBlobShas(this.db.vault);
    for (const sha of archivedSegmentShas(this.db.audit)) live.add(sha);
    for (const sha of conversationArchiveShas(this.db.audit)) live.add(sha);
    // Retained-snapshot GC roots (#436) must NOT join `live`: recovery-to-N
    // still needs them, and `live` would re-push a remote-only original.
    const result = await this.db.blobs.reconcile(live, {
      ...(options?.skipOrphanDelete ? { skipOrphanDelete: true } : {}),
      ...(options?.extraLiveRoots
        ? { extraLiveRoots: options.extraLiveRoots }
        : {}),
      // Orphan-grace window (#439): wait past the recovery window N.
      ...(options?.graceWindowMs === undefined
        ? {}
        : { graceWindowMs: options.graceWindowMs }),
    });
    // Refresh the app-readable custody mirror AFTER reconcile, so it reflects
    // the post-sweep steady state rather than a stale gap.
    await refreshCustodyState(this.db);
    // Rollup (#711) needs the fresh mirror AND healed replica evidence — the
    // same condition BlobCache requires before shedding an original.
    refreshCustodyRollup(this.db);
    // Preview backstop (#405): fill missing tiny/medium derivatives, bounded,
    // best-effort (failures never fail the sweep). Real work in blob/preview.ts.
    let previewsGenerated = 0;
    let phashesGenerated = 0;
    let thumbhashesGenerated = 0;
    if (this.db.previewCodec) {
      try {
        const backfill = await backfillPreviews(this.db, this.db.previewCodec);
        previewsGenerated = backfill.generated;
        phashesGenerated = backfill.phashesGenerated;
        thumbhashesGenerated = backfill.thumbhashesGenerated;
      } catch {
        // swallowed on purpose — see the comment above.
      }
    }
    // Leases and backstops share the derivative row as completion truth:
    // close an expired job once its rung exists.
    drainSatisfiedEnrichmentRequests(this.db.vault);
    // Bounded-cache eviction (#405) runs LAST, against fresh evidence — never
    // sheds a tiny just made. Pinned tinies, staged bytes and un-replicated
    // last copies are untouchable.
    const evicted = this.db.blobs.evictAfterReconcile();
    const receiptId = writeReceipt(this.db.audit, {
      grantId: null,
      invocationId: null,
      action: "act access.blob_sweep",
      objectType: "core.content_item",
      objectId: null,
      purpose: null,
      decision: "allow",
      detail: {
        orphansDeleted: result.orphansDeleted.length,
        orphansSkipped: result.orphansSkipped.length,
        // Held by the recovery-window grace (#439) — deferred, not skipped.
        orphansGraceHeld: result.orphansGraceHeld.length,
        replicated: result.replicated.length,
        missing: result.missing,
        // 0 when no codec is wired or no image was missing a rung.
        previewsGenerated,
        // Inline dHash contributions published beside preview rungs.
        phashesGenerated,
        // Inline ThumbHash placeholders published beside preview rungs.
        thumbhashesGenerated,
        // 0 when the spool is under budget or the vault is local-only.
        evictedBlobs: evicted.evictedBlobs,
        evictedBytes: evicted.evictedBytes,
      },
    });
    return { ...result, receiptId };
  }

  importIcs(cred: Credential, icsText: string): ImportResult {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner imports (v0)");
    const result = importIcsEvents(this.db, owner, icsText);
    this.ringProvenance();
    return result;
  }

  importVcards(cred: Credential, vcfText: string): ImportResult {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner imports (v0)");
    const result = importVcardParties(this.db, owner, vcfText);
    this.ringProvenance();
    return result;
  }

  exportVault(cred: Credential): {
    artifact: VaultExport;
    exportId: string;
    receiptId: string;
  } {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner exports the vault");
    return exportVault(this.db, owner);
  }

  async exportPortableVault(
    cred: Credential,
    options: PortableExportOptions = {}
  ): Promise<PortableExport> {
    const owner = this.identify(cred);
    if (owner.kind !== "owner-device")
      throw new GatewayError("access", "only the owner exports the vault");
    return exportPortableVault(this.db, owner, options);
  }

  listParked(): ParkedSummary[] {
    return listDurableParkedPayloads(this.db).map((p) => ({
      invocationId: p.invocationId,
      command: p.commandName,
      parkedAt: p.parkedAt,
      callerKind: this.callerKind(p.identity),
      callerId: p.identity.callerId,
      caller: this.callerName(p.identity),
      // The confirmation surface shows WHAT is asked, never secret material
      // (#293): sealed inputs ride as hash tokens, nested ext secrets included.
      input: redactCommandInput(
        this.db.sealKey,
        p.commandName,
        p.request.input,
        this.commands.get(p.commandName)?.sealedInput ?? [],
        this.db.vault
      ),
    }));
  }

  /**
   * Refines `Identity['kind']`'s `'agent'` into `'assistant'` for the vault
   * assistant's own enrolled identity (`_assistant`, `invokeAsAssistant`).
   */
  private callerKind(identity: Identity): ParkedCallerKind {
    if (identity.kind !== "agent") return identity.kind;
    const row = this.db.vault
      .prepare("SELECT enrollment_key FROM access_agent WHERE agent_id = ?")
      .get(identity.callerId) as { enrollment_key: string } | undefined;
    return row?.enrollment_key === "_assistant" ? "assistant" : "agent";
  }

  /** WHO wants the act, for the owner. */
  private callerName(identity: Identity): string | null {
    if (identity.kind === "owner-device") return "owner";
    const byApp = identity.kind === "app";
    const row = this.db.vault
      .prepare(
        byApp
          ? "SELECT COALESCE(display_name, name) AS name FROM access_app WHERE app_id = ?"
          : `SELECT p.display_name AS name FROM access_agent a
               JOIN core_party p ON p.party_id = a.party_id WHERE a.agent_id = ?`
      )
      .get(identity.callerId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  private ringProvenance(entityTypes?: readonly string[]): void {
    try {
      this.deps.onProvenanceCommitted?.(entityTypes);
    } catch {
      // Doorbells are hints; the persisted cursor + cron poll own correctness.
    }
  }

  private ringDecisionChanged(created: boolean): void {
    if (this.activeBatchDecisionChanges) {
      this.activeBatchDecisionChanges.push(created);
      return;
    }
    this.emitDecisionChanged(created);
  }

  private emitDecisionChanged(created: boolean): void {
    try {
      this.deps.onDecisionChanged?.(created);
    } catch {
      // Doorbells are hints; the persisted Notifications projection owns correctness.
    }
  }
}

export function createGateway(db: VaultDb, deps: GatewayDeps = {}): Gateway {
  return new Gateway(db, deps);
}
