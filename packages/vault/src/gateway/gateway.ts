// governance: allow-repo-hygiene file-size-limit the one-door pipeline (§10) — identity → consent → contract → execution → evidence must stay one auditable unit

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

const LOCKER_SIDECAR_ENTITIES = new Set([
  "locker.item_field",
  "locker.item_passkey",
]);

export interface GatewayDeps {
  onProvenanceCommitted?: (entityTypes?: readonly string[]) => void;
  onDecisionChanged?: (created: boolean) => void;
  onCommonsCommandSequenced?: (grantId: string) => void;
  onCommonsIntentQueued?: (grantId: string) => void;
}

export type InvocationBatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

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

  authenticateLocker(request: LockerAuthRequest): Promise<LockerAuthResult> {
    return this.lockerAuthentication.handle(request);
  }

  authorizeLockerReveal(
    authentication: RevealRequest["authentication"],
    itemId: string
  ): void {
    this.lockerAuthentication.authorizeReveal(authentication, itemId, "ui");
  }

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

  invokeBatch<T>(runs: readonly (() => T)[]): T[] {
    return this.invokeBatchSettled(runs).map((result) => {
      if (!result.ok) throw result.error;
      return result.value;
    });
  }

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
          const committedAfterStart = (
            this.db.vault
              .prepare("SELECT invocation_id FROM replica_invocation_commit")
              .all() as { invocation_id: string }[]
          ).some((row) => !markersBefore.has(row.invocation_id));
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

  private emitCommonsCommandSequenced(grantId: string): void {
    try {
      this.deps.onCommonsCommandSequenced?.(grantId);
    } catch {
      // Intentionally empty.
    }
  }

  private emitCommonsIntentQueued(grantId: string): void {
    try {
      this.deps.onCommonsIntentQueued?.(grantId);
    } catch {
      // Intentionally empty.
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

  private identify(cred: Credential): Identity {
    return authenticate(this.db.vault, cred);
  }

  readBatch<T>(body: () => T): T {
    if (this.db.vault.isTransaction || this.db.audit.isTransaction)
      throw new Error("gateway read batch cannot nest");
    this.db.vault.exec("BEGIN IMMEDIATE");
    try {
      return body();
    } finally {
      if (this.db.vault.isTransaction) this.db.vault.exec("COMMIT");
    }
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
    const target = this.db.vault;
    const now = nowIso();
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
    const order = compileOrderBy(
      target,
      ref.physical,
      request.orderBy,
      exposedPrimaryKey
    );
    const select = applyFieldMask(target, ref.physical, access.fieldMask);
    const limit = Math.min(Math.max(request.limit ?? 1000, 1), 10_000);
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
        ...(owningItemId !== null && owningItemId !== entityId
          ? { itemId: owningItemId }
          : {}),
        ...(request.alias === undefined ? {} : { alias: request.alias }),
        ...(context ? { context } : {}),
      },
    });
    return { values, receiptId };
  }

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

  search(cred: Credential, rawRequest: SearchRequest): SearchResult {
    const identity = this.identify(cred);
    const request = {
      ...rawRequest,
      purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
    };
    const result = searchEntity(this.db, identity, request);
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

  resolveRefs(cred: Credential, request: RefRequest): ResolveResult {
    const identity = this.identify(cred);
    return resolveRefCards(this.db.vault, this.db.audit, identity, request);
  }

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

  invoke(cred: Credential, rawRequest: InvokeRequest): InvokeOutcome {
    const identity = this.identify(cred);
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
    const request = {
      ...rawRequest,
      purpose: rawRequest.purpose ?? DEFAULT_PURPOSE,
    };
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
    recomputeDuplicateClusters(this.db.vault);
    rebuildMemories(this.db.vault);
    rebuildFaceClusters(this.db.vault);
    releaseExpiredEnrichmentLeases(this.db.vault);
    drainSatisfiedEnrichmentRequests(this.db.vault);
    queueMissingDeviceEnrichmentBacklog(this.db.vault, {
      newId: () => uuidv7(),
      requestedAt: nowIso(),
      limit: 100,
    });
    this.ringProvenance();
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
    const live = liveBlobShas(this.db.vault);
    for (const sha of archivedSegmentShas(this.db.audit)) live.add(sha);
    for (const sha of conversationArchiveShas(this.db.audit)) live.add(sha);
    const result = await this.db.blobs.reconcile(live, {
      ...(options?.skipOrphanDelete ? { skipOrphanDelete: true } : {}),
      ...(options?.extraLiveRoots
        ? { extraLiveRoots: options.extraLiveRoots }
        : {}),
      ...(options?.graceWindowMs === undefined
        ? {}
        : { graceWindowMs: options.graceWindowMs }),
    });
    await refreshCustodyState(this.db);
    refreshCustodyRollup(this.db);
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
        // Intentionally empty.
      }
    }
    drainSatisfiedEnrichmentRequests(this.db.vault);
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
        orphansGraceHeld: result.orphansGraceHeld.length,
        replicated: result.replicated.length,
        missing: result.missing,
        previewsGenerated,
        phashesGenerated,
        thumbhashesGenerated,
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
      input: redactCommandInput(
        this.db.sealKey,
        p.commandName,
        p.request.input,
        this.commands.get(p.commandName)?.sealedInput ?? [],
        this.db.vault
      ),
    }));
  }

  private callerKind(identity: Identity): ParkedCallerKind {
    if (identity.kind !== "agent") return identity.kind;
    const row = this.db.vault
      .prepare("SELECT enrollment_key FROM access_agent WHERE agent_id = ?")
      .get(identity.callerId) as { enrollment_key: string } | undefined;
    return row?.enrollment_key === "_assistant" ? "assistant" : "agent";
  }

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
      // Intentionally empty.
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
      // Intentionally empty.
    }
  }
}

export function createGateway(db: VaultDb, deps: GatewayDeps = {}): Gateway {
  return new Gateway(db, deps);
}
