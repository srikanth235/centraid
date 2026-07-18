// governance: allow-repo-hygiene file-size-limit the one-door pipeline (§10) — identity → consent → contract → execution → evidence must stay one auditable unit
// The gateway (§10): one door, every request, no exceptions. Sole holder of
// connections; every read and typed command walks identity → consent →
// contract → execution → evidence. It stays a thin, mostly declarative
// interpreter over the consent and capability tables: no domain logic, no
// reasoning, no rendering. Byte custody (issue #296) rides the same door —
// staging is pre-model (no receipt until a command claims), egress is
// consent-checked resolution; the bytes themselves live behind db.blobs.

import type { DatabaseSync } from 'node:sqlite';
import { nowIso, uuidv7 } from '../ids.js';
import type { VaultDb } from '../db.js';
import { resolveServableBlob, liveBlobShas, type BlobResolveOutcome } from '../blob/read.js';
import { archivedSegmentShas } from '../journal-archive.js';
import { conversationArchiveShas } from '../conversation-archive-roots.js';
import {
  AGENT_CONTENT_VARIANTS,
  resolveAgentContent,
  type AgentContentOutcome,
  type AgentContentVariant,
} from '../enrich/content.js';
import { recomputeDuplicateClusters } from '../enrich/clusters.js';
import {
  drainSatisfiedEnrichmentRequests,
  queueMissingDeviceEnrichmentBacklog,
  releaseExpiredEnrichmentLeases,
} from '../enrich/leases.js';
import { stageBlobBytes, type StageBlobOptions, type StagedBlob } from '../blob/staging.js';
import { refreshCustodyState, type ReconcileResult } from '../blob/custody.js';
import { backfillPreviews } from '../blob/preview.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import { resolveEntity } from '../schema/tables.js';
import { resolveRefCards, type RefRequest, type ResolveResult } from './cards.js';
import { evaluateConsent, type ConsentAllow } from './consent.js';
import { lookupCommand } from './contract.js';
import {
  revokeGrantCascade,
  sweepLifecycle,
  type RevocationResult,
  type SweepResult,
} from './duties.js';
import { writeReceipt } from './evidence.js';
import {
  assertInvocationIdentity,
  insertInvocation,
  replayInvocation,
  pkColumn,
  runContractAndExecute,
  setInvocationStatus,
  type RegisteredCommand,
} from './execution.js';
import {
  isSealedValue,
  redactCommandInput,
  sealAad,
  SEALED_PLACEHOLDER,
  sealedColumnsOf,
  stampSealKeyFingerprint,
  unsealValue,
} from '../schema/sealed.js';
import {
  applyFieldMask,
  compileFilters,
  compileOrderBy,
  scalarPrimaryKeyColumn,
} from './filters.js';
import { authenticate } from './identity.js';
import { searchEntity } from './search.js';
import {
  runReadOnlySql,
  VAULT_SQL_DEFAULT_ROWS,
  type VaultSqlRequest,
  type VaultSqlResult,
} from './sql.js';
import { importIcsEvents, importVcardParties, type ImportResult } from '../ingest/import.js';
import { stageFile, type StageFileOptions, type StageFileResult } from '../ingest/stage-file.js';
import { discardBatch, publishBatch, type PublishResult } from '../ingest/staging.js';
import { PUBLISHERS } from '../ingest/publishers.js';
import { demoStatus, purgeDemoRows, type DemoPurgeResult } from './demo.js';
import { SEED_DEMO_ACTIVITY } from '../schema/seed.js';
import { backupVault, checkpointVault, type BackupResult } from './custody.js';
import {
  applyExtBand,
  dropExtBand,
  extAppIds,
  extCommandDefinitions,
  extCommandNames,
  purgeExtBand,
  retainExtBand,
  seedExtDraft,
  type ExtApplyOutcome,
} from './ext.js';
import type { ExtTableSpec } from '../schema/ext.js';
import { exportVault, type VaultExport } from './portability.js';
import { queryAppView, registerAppView, type ViewDefinition, type ViewResult } from './views.js';
import {
  deleteDurableParkedPayloadsForGrant,
  listDurableParkedPayloads,
  readDurableParkedDenial,
  readDurableParkedPayload,
  recordDurableParkedDenial,
  saveDurableParkedPayload,
  settleDurableParkedPayload,
} from '../replica/parked.js';
import { transitionReplicaIntentOutcomeInTransaction } from '../replica/intents.js';
import {
  reclaimProvenOrdinaryInvocationCommitsInTransaction,
  stampFinalizedInvocationCommitInTransaction,
} from '../replica/invocation-commits.js';
import { notifyReplicaCommit } from '../replica/doorbell.js';
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
} from './types.js';
import { DEFAULT_PURPOSE, GatewayError } from './types.js';

/**
 * Structural guard for reading `consent.provenance` (issue #352 phase 3/4 —
 * the app-plane activity read). journal.db already carries a full audit
 * trail keyed by (entity_type, entity_id) — every command write stamps one
 * via `writeProvenance` — and `consent.provenance` is a registered logical
 * entity, so a table-scoped grant alone would let `read()`'s normal path
 * return it. That is not enough: a caller holding read on `consent.provenance`
 * could otherwise pass ANY `entity_type` in `where` and browse another app's
 * or another domain's activity history wholesale — the grant is a table-level
 * yes/no, it cannot itself express "only entities you can already read".
 *
 * So a non-owner read of this one table is held to two EXTRA rules beyond
 * the normal consent check: it must scope to exactly one (entity_type,
 * entity_id) pair, and the caller must independently hold read consent on
 * that entity's own table. Returns a failure reason, or null when the read
 * is properly scoped. Owner-device reads (the assistant, the shell) bypass
 * this — same as every other entity, the owner already sees everything.
 */
function provenanceScopeFailure(
  vault: DatabaseSync,
  identity: Identity,
  request: ReadRequest,
): string | null {
  const eqValue = (column: string): string | undefined => {
    const clause = (request.where ?? []).find((c) => c.column === column && c.op === 'eq');
    return typeof clause?.value === 'string' ? clause.value : undefined;
  };
  const targetType = eqValue('entity_type');
  const targetId = eqValue('entity_id');
  if (!targetType || !targetId) {
    return 'activity reads must scope to exactly one entity_type and one entity_id (eq filters)';
  }
  const targetRef = resolveEntity(targetType, vault);
  if (!targetRef || targetRef.file !== 'vault') {
    return `activity target names unknown entity "${targetType}"`;
  }
  const targetConsent = evaluateConsent(
    vault,
    identity,
    targetRef.schema,
    targetRef.table,
    'read',
    request.purpose,
  );
  if (targetConsent.decision === 'deny') {
    return `no read consent for ${targetType}: ${targetConsent.failing}`;
  }
  return null;
}

export type InvocationBatchResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export class Gateway {
  /** Registered commands: handler + sealed-class declarations (issue #293). */
  private readonly commands = new Map<string, RegisteredCommand>();
  private activeBatchInvocationIds: string[] | undefined;

  constructor(private readonly db: VaultDb) {}

  /**
   * Run one short arrival window inside a shared vault + journal commit pair.
   * Each invocation keeps its own savepoints, contract checks and outcome;
   * successful canonical markers are provisionally stamped in the vault
   * transaction and re-verified before a later shared pair reclaims them.
   */
  invokeBatch<T>(runs: readonly (() => T)[]): T[] {
    return this.invokeBatchSettled(runs).map((result) => {
      if (!result.ok) throw result.error;
      return result.value;
    });
  }

  /**
   * Batch variant used by the request queue. A post-canonical journal failure
   * rejects only its own caller: its vault mutation and recovery marker still
   * cross the shared vault commit boundary, while the journal savepoint is
   * rolled back for deterministic replay on retry.
   */
  invokeBatchSettled<T>(runs: readonly (() => T)[]): InvocationBatchResult<T>[] {
    if (runs.length === 0) return [];
    if (
      this.activeBatchInvocationIds ||
      this.db.vault.isTransaction ||
      this.db.journal.isTransaction
    ) {
      throw new Error('gateway invocation batch cannot nest');
    }
    const invocationIds: string[] = [];
    this.activeBatchInvocationIds = invocationIds;
    try {
      this.db.vault.exec('BEGIN IMMEDIATE');
      this.db.journal.exec('BEGIN IMMEDIATE');
      reclaimProvenOrdinaryInvocationCommitsInTransaction(this.db);
      const results = runs.map((run): InvocationBatchResult<T> => {
        try {
          return { ok: true, value: run() };
        } catch (error) {
          return { ok: false, error };
        }
      });
      for (const invocationId of invocationIds) {
        stampFinalizedInvocationCommitInTransaction(this.db.vault, invocationId);
      }
      this.db.vault.exec('COMMIT');
      this.db.journal.exec('COMMIT');
      // A rejected run may still have crossed the canonical boundary and left
      // a pending marker. Publish only once journal proof is also durable.
      notifyReplicaCommit(this.db.vault);
      return results;
    } catch (error) {
      if (this.db.journal.isTransaction) this.db.journal.exec('ROLLBACK');
      if (this.db.vault.isTransaction) this.db.vault.exec('ROLLBACK');
      throw error;
    } finally {
      this.activeBatchInvocationIds = undefined;
    }
  }

  private trackBatchInvocation(outcome: InvokeOutcome): InvokeOutcome {
    if (
      this.activeBatchInvocationIds &&
      (outcome.status === 'executed' || outcome.status === 'replayed')
    ) {
      this.activeBatchInvocationIds.push(outcome.invocationId);
    }
    return outcome;
  }

  /** Register a domain command: the agent.command contract row + handler. */
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
    // Confirmation is a Tier 3/4 property of the COMMAND (issue #306
    // decision 1), not a function of risk — risk is a salience marker.
    const requiresConfirmation = def.confirm === true ? 1 : 0;
    if (existing) {
      this.db.vault
        .prepare(
          `UPDATE agent_command SET name=?, owner_schema=?, input_schema_json=?, output_schema_json=?,
             preconditions_json=?, postconditions_json=?, idempotency=?, risk=?, ontology_version=?
           WHERE command_id=?`,
        )
        .run(...params, commandId);
      this.db.vault
        .prepare(`UPDATE agent_capability SET requires_confirmation=? WHERE command_id=?`)
        .run(requiresConfirmation, commandId);
    } else {
      this.db.vault
        .prepare(
          `INSERT INTO agent_command (command_id, name, owner_schema, input_schema_json, output_schema_json,
             preconditions_json, postconditions_json, idempotency, risk, ontology_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(commandId, ...params);
      this.db.vault
        .prepare(
          `INSERT INTO agent_capability (capability_id, schema_name, verb, command_id, description, requires_confirmation)
           VALUES (?, ?, 'act', ?, ?, ?)`,
        )
        .run(uuidv7(), def.ownerSchema, commandId, def.name, requiresConfirmation);
    }
    this.commands.set(def.name, {
      handler: def.handler,
      sealedInput: def.sealedInput ?? [],
      unseals: def.unseals ?? [],
      transcriptSensitive: def.transcriptSensitive ?? false,
    });
  }

  /** The discover surface: capabilities visible to any authenticated caller. */
  discover(
    cred: Credential,
  ): { name: string; schema: string; risk: Risk; requiresConfirmation: boolean }[] {
    this.identify(cred);
    const rows = this.db.vault
      .prepare(
        `SELECT c.name, c.owner_schema, c.risk, cap.requires_confirmation
           FROM agent_command c JOIN agent_capability cap ON cap.command_id = c.command_id`,
      )
      .all() as { name: string; owner_schema: string; risk: Risk; requires_confirmation: number }[];
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

  /** Consent-checked read: row filters and field masks applied, receipted. */
  read(cred: Credential, rawRequest: ReadRequest): ReadResult {
    const identity = this.identify(cred);
    const request = { ...rawRequest, purpose: rawRequest.purpose ?? DEFAULT_PURPOSE };
    const ref = resolveEntity(request.entity, this.db.vault);
    if (!ref) {
      const receiptId = writeReceipt(this.db.journal, {
        grantId: null,
        invocationId: null,
        action: 'read',
        objectType: request.entity,
        objectId: null,
        purpose: request.purpose,
        decision: 'deny',
        detail: { failing: 'unknown entity' },
      });
      throw new GatewayError(
        'consent',
        `deny (receipt ${receiptId}): unknown entity ${request.entity}`,
      );
    }
    const consent = evaluateConsent(
      this.db.vault,
      identity,
      ref.schema,
      ref.table,
      'read',
      request.purpose,
    );
    if (consent.decision === 'deny') {
      const receiptId = writeReceipt(this.db.journal, {
        grantId: consent.grantId,
        invocationId: null,
        action: 'read',
        objectType: request.entity,
        objectId: null,
        purpose: request.purpose,
        decision: 'deny',
        detail: { failing: consent.failing },
      });
      throw new GatewayError('consent', `deny (receipt ${receiptId}): ${consent.failing}`);
    }
    // Per-entity activity guard (issue #352 phase 3/4) — see
    // provenanceScopeFailure's doc comment for why a table-level grant on
    // consent.provenance alone is not a safe read.
    if (
      ref.schema === 'consent' &&
      ref.table === 'provenance' &&
      identity.kind !== 'owner-device'
    ) {
      const failing = provenanceScopeFailure(this.db.vault, identity, request);
      if (failing) {
        const receiptId = writeReceipt(this.db.journal, {
          grantId: consent.grantId,
          invocationId: null,
          action: 'read',
          objectType: request.entity,
          objectId: null,
          purpose: request.purpose,
          decision: 'deny',
          detail: { failing },
        });
        throw new GatewayError('consent', `deny (receipt ${receiptId}): ${failing}`);
      }
    }
    const target = ref.file === 'vault' ? this.db.vault : this.db.journal;
    const now = nowIso();
    // Your own business only: an agent reading the invocation ledger sees
    // ITS invocations, structurally — this is how a parked send resumes
    // (watch your own rows for status changes) without any caller ever
    // reading another actor's traffic. Not grant-configurable: appended
    // beside the grant filter, so it can narrow but never widen.
    const structuralFilter =
      identity.kind === 'agent' && request.entity === 'agent.command_invocation'
        ? [{ column: 'agent_id', op: 'eq' as const, value: identity.callerId }]
        : [];
    const grantFilter = compileFilters(
      target,
      ref.physical,
      [...consent.rowFilter, ...structuralFilter],
      now,
    );
    const callerFilter = compileFilters(target, ref.physical, request.where ?? [], now);
    const sealedCols = sealedColumnsOf(request.entity, this.db.vault);
    const scalarPrimaryKey = scalarPrimaryKeyColumn(target, ref.physical);
    const exposedPrimaryKey =
      scalarPrimaryKey !== undefined &&
      !sealedCols.includes(scalarPrimaryKey) &&
      (consent.fieldMask === null || consent.fieldMask.includes(scalarPrimaryKey))
        ? scalarPrimaryKey
        : undefined;
    // Ordering is what turns a bounded read into a RECENT window (issue
    // #262) — validated like a filter column, so it can't widen anything.
    // An exposed scalar PK is the stable secondary key shared with browser
    // replicas. Hidden/composite keys stay opaque and local ties rerun here.
    const order = compileOrderBy(target, ref.physical, request.orderBy, exposedPrimaryKey);
    const select = applyFieldMask(target, ref.physical, consent.fieldMask);
    const limit = Math.min(Math.max(request.limit ?? 1000, 1), 10_000);
    // The automation plane never sees demo data (issue #290 phase 1):
    // condition triggers evaluate agent-credentialed reads, so seeded rows
    // are structurally excluded here — a fake "rent due" row must not fire a
    // real reminder. Owners and apps DO see demo rows: rendering them is the
    // scenario's whole point. Appended beside the grant filter, so it can
    // narrow but never widen.
    const demoExclusion =
      identity.kind === 'agent' && ref.file === 'vault' && ref.schema !== 'consent'
        ? ` AND NOT EXISTS (SELECT 1 FROM consent_seed_row _s
             WHERE _s.entity_type = ? AND _s.entity_id = "${ref.physical}"."${pkColumn(target, ref.physical)}")`
        : '';
    const rows = target
      .prepare(
        `SELECT ${select} FROM "${ref.physical}" WHERE ${grantFilter.where} AND ${callerFilter.where}${demoExclusion}${order} LIMIT ${limit}`,
      )
      .all(
        ...grantFilter.params,
        ...callerFilter.params,
        ...(demoExclusion ? [request.entity] : []),
      ) as Record<string, unknown>[];
    // Sealed columns never ride a read (issue #293): default reads show a
    // placeholder; plaintext takes the `reveal` verb and its per-item receipt.
    if (sealedCols.length > 0) {
      for (const row of rows) {
        for (const col of sealedCols) {
          if (row[col] != null && row[col] !== '') row[col] = SEALED_PLACEHOLDER;
        }
      }
    }
    const receiptId = writeReceipt(this.db.journal, {
      grantId: consent.grantId,
      invocationId: null,
      action: 'read',
      objectType: request.entity,
      objectId: null,
      purpose: request.purpose,
      decision: 'allow',
      detail: { filter: request.where ?? [], rowCount: rows.length },
    });
    return { rows, receiptId };
  }

  /**
   * Reveal (issue #293): plaintext of one entity's sealed columns, under the
   * `reveal` scope verb — never `read`, never `read+act`. Owner devices pass
   * (they own the model) unless readonly; every reveal writes a receipt
   * naming the item and the columns, so "what looked at my secrets" always
   * has an answer. Values never touch the journal.
   */
  reveal(cred: Credential, rawRequest: RevealRequest): RevealResult {
    const identity = this.identify(cred);
    const request = { ...rawRequest, purpose: rawRequest.purpose ?? DEFAULT_PURPOSE };
    const deny = (failing: string, grantId: string | null = null): never => {
      const receiptId = writeReceipt(this.db.journal, {
        grantId,
        invocationId: null,
        action: 'reveal',
        objectType: request.entity,
        objectId: request.entityId ?? (request.alias ? `@${request.alias}` : null),
        purpose: request.purpose,
        decision: 'deny',
        detail: { failing },
      });
      throw new GatewayError('consent', `deny (receipt ${receiptId}): ${failing}`);
    };
    const ref = resolveEntity(request.entity, this.db.vault);
    if (!ref || ref.file !== 'vault') return deny(`unknown entity ${request.entity}`);
    const sealedCols = sealedColumnsOf(request.entity, this.db.vault);
    if (sealedCols.length === 0) return deny(`${request.entity} has no sealed columns`);
    const columns = request.columns ?? [...sealedCols];
    for (const col of columns) {
      if (!sealedCols.includes(col)) return deny(`${col} is not a sealed column`);
    }
    // Resolve a stable alias to the live item (issue #298 item 4). Only
    // locker.item carries aliases; the lookup rides the reveal grant, so no
    // separate read scope is needed for a connector to survive a rotation.
    let entityId = request.entityId;
    if (request.alias !== undefined) {
      if (request.entity !== 'locker.item') return deny('alias reveal is locker.item only');
      const hit = this.db.vault
        .prepare(
          `SELECT a.item_id FROM locker_item_alias a
             JOIN locker_item i ON i.item_id = a.item_id
            WHERE a.alias = ? AND i.deleted_at IS NULL`,
        )
        .get(request.alias) as { item_id: string } | undefined;
      if (!hit) return deny(`no live locker item with alias "${request.alias}"`);
      entityId = hit.item_id;
    }
    if (!entityId) return deny('reveal needs an entityId or alias');
    const consent = evaluateConsent(
      this.db.vault,
      identity,
      ref.schema,
      ref.table,
      'reveal',
      request.purpose,
    );
    if (consent.decision === 'deny') return deny(consent.failing, consent.grantId);
    const pk = pkColumn(this.db.vault, ref.physical);
    // The grant's row filter clamps WHICH items are revealable — this is how
    // a connector's grant names its specific locker items (issue #293 dec 8).
    const rowFilter = compileFilters(this.db.vault, ref.physical, consent.rowFilter, nowIso());
    const select = columns.map((c) => `"${c}"`).join(', ');
    const row = this.db.vault
      .prepare(`SELECT ${select} FROM "${ref.physical}" WHERE "${pk}" = ? AND ${rowFilter.where}`)
      .get(entityId, ...rowFilter.params) as Record<string, unknown> | undefined;
    if (!row) return deny(`no revealable ${request.entity} row ${entityId}`);
    const values: Record<string, string | null> = {};
    let unsealedAny = false;
    for (const col of columns) {
      const value = row[col];
      if (value == null || value === '') {
        values[col] = null;
      } else if (isSealedValue(value)) {
        values[col] = unsealValue(this.db.sealKey, sealAad(ref.physical, col, entityId), value);
        unsealedAny = true;
      } else {
        values[col] = String(value); // pre-seal legacy plaintext
      }
    }
    // A successful unseal proves this key sealed this vault's secrets —
    // stamp the fingerprint if a pre-#298 vault never recorded it, so the
    // open-time custody check covers legacy vaults too.
    if (unsealedAny) stampSealKeyFingerprint(this.db.vault, this.db.sealKey);
    const receiptId = writeReceipt(this.db.journal, {
      grantId: consent.grantId,
      invocationId: null,
      action: 'reveal',
      objectType: request.entity,
      objectId: entityId,
      purpose: request.purpose,
      decision: 'allow',
      detail: { columns, ...(request.alias !== undefined ? { alias: request.alias } : {}) },
    });
    return { values, receiptId };
  }

  /**
   * The owner's whole-model SQL read (the vault assistant's primary tool):
   * one read-only statement over the full canonical schema — joins, window
   * functions, recursive CTEs over core_link. Owner-device credential only;
   * no consent clamping applies because there is no third party in the
   * loop, but every run is receipted like any other read.
   */
  sql(cred: Credential, request: VaultSqlRequest): VaultSqlResult {
    const identity = this.identify(cred);
    const purpose = request.purpose ?? 'owner-assistant';
    if (identity.kind !== 'owner-device') {
      const receiptId = writeReceipt(this.db.journal, {
        grantId: null,
        invocationId: null,
        action: 'read',
        objectType: 'vault.sql',
        objectId: null,
        purpose,
        decision: 'deny',
        detail: { failing: 'whole-model sql is owner-only' },
      });
      throw new GatewayError(
        'consent',
        `deny (receipt ${receiptId}): whole-model sql is the owner's surface`,
      );
    }
    const result = runReadOnlySql(this.db, request.sql, request.maxRows ?? VAULT_SQL_DEFAULT_ROWS);
    const receiptId = writeReceipt(this.db.journal, {
      grantId: null,
      invocationId: null,
      action: 'read',
      objectType: 'vault.sql',
      objectId: null,
      purpose,
      decision: 'allow',
      detail: {
        sql: request.sql.length > 400 ? `${request.sql.slice(0, 400)}…` : request.sql,
        rowCount: result.totalRows,
        durationMs: result.durationMs,
      },
    });
    return { ...result, receiptId };
  }

  /**
   * Consent-checked full-text search over a text-indexed entity: matching
   * runs inside SQLite's FTS5 shadow tables (schema/fts.ts), so a caller
   * gets its LIMIT of ranked matches instead of a whole table to grep.
   */
  search(cred: Credential, rawRequest: SearchRequest): SearchResult {
    const identity = this.identify(cred);
    const request = { ...rawRequest, purpose: rawRequest.purpose ?? DEFAULT_PURPOSE };
    const result = searchEntity(this.db, identity, request);
    // Search-miss prioritization (issue #299 phase 5): an OWNER search that
    // found nothing records what was wanted; enrichers drain the queue
    // before their backlog. Owner-plane only (an app's misses are its own
    // business), deduped against open requests so repeat searches don't
    // spam the queue.
    if (result.rows.length === 0 && identity.kind === 'owner-device') {
      const open = this.db.vault
        .prepare(
          `SELECT 1 AS x FROM enrich_request
            WHERE entity_type = ? AND reason = 'search-miss' AND detail = ? AND drained_at IS NULL`,
        )
        .get(request.entity, request.query);
      if (!open) {
        this.db.vault
          .prepare(
            `INSERT INTO enrich_request (request_id, entity_type, entity_id, reason, detail, requested_at, drained_at)
             VALUES (?, ?, NULL, 'search-miss', ?, ?, NULL)`,
          )
          .run(uuidv7(), request.entity, request.query, nowIso());
      }
    }
    return result;
  }

  /**
   * The card resolver (issue #272): (type, id) references → minimal
   * renderable cards, under the resolvable-if-linked consent rule — so a
   * projection renders what the owner linked into its view without holding
   * read scopes on the foreign domain. Receipted per batch; per-ref denials
   * come back as 'denied' cards, never as an exception.
   */
  resolveRefs(cred: Credential, request: RefRequest): ResolveResult {
    const identity = this.identify(cred);
    return resolveRefCards(this.db.vault, this.db.journal, identity, request);
  }

  /**
   * The consented change feed (data triggers' outbox): provenance rows for
   * the watched entities after the caller's cursor. Every watched entity is
   * consent-checked for read under the declared purpose — one denied entity
   * denies the whole pull (fail closed, receipted). A `null` cursor
   * bootstraps: no rows, just the current watermark, so a fresh watcher
   * never replays history it was not granted while it happened.
   */
  changes(cred: Credential, rawRequest: ChangesRequest): ChangesResult {
    const identity = this.identify(cred);
    const request = { ...rawRequest, purpose: rawRequest.purpose ?? DEFAULT_PURPOSE };
    if (request.entities.length === 0) {
      throw new GatewayError('contract', 'changes needs at least one entity to watch');
    }
    for (const entity of request.entities) {
      const ref = resolveEntity(entity, this.db.vault);
      const consent = ref
        ? evaluateConsent(this.db.vault, identity, ref.schema, ref.table, 'read', request.purpose)
        : ({ decision: 'deny', failing: `unknown entity ${entity}`, grantId: null } as const);
      if (consent.decision === 'deny') {
        const receiptId = writeReceipt(this.db.journal, {
          grantId: consent.grantId,
          invocationId: null,
          action: 'read',
          objectType: 'consent.provenance',
          objectId: null,
          purpose: request.purpose,
          decision: 'deny',
          detail: { failing: consent.failing, entity },
        });
        throw new GatewayError('consent', `deny (receipt ${receiptId}): ${consent.failing}`);
      }
    }
    const watermarkRow = this.db.journal
      .prepare('SELECT prov_id FROM consent_provenance ORDER BY prov_id DESC LIMIT 1')
      .get() as { prov_id: string } | undefined;
    const watermark = watermarkRow?.prov_id ?? '';
    let changes: ChangeEntry[] = [];
    let cursor = request.cursor ?? watermark;
    if (request.cursor !== null) {
      const limit = Math.min(Math.max(request.limit ?? 200, 1), 500);
      const placeholders = request.entities.map(() => '?').join(', ');
      // Demo writes never reach the feed (issue #290 phase 1): data triggers
      // ride this outbox, and scenario data must not fire automations.
      const rows = this.db.journal
        .prepare(
          `SELECT prov_id, entity_type, entity_id, prov_activity, agent_kind, occurred_at
             FROM consent_provenance
            WHERE prov_id > ? AND entity_type IN (${placeholders})
              AND prov_activity != '${SEED_DEMO_ACTIVITY}'
            ORDER BY prov_id ASC LIMIT ${limit}`,
        )
        .all(request.cursor, ...request.entities) as {
        prov_id: string;
        entity_type: string;
        entity_id: string;
        prov_activity: string;
        agent_kind: ChangeEntry['agentKind'];
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
      // Advance to the last matched row; on an empty pull, jump to the
      // pre-select watermark (safe — it was captured before the range scan,
      // so nothing ≤ it can still be unmatched-but-matching) so a quiet
      // watcher never rescans the same cold range twice.
      if (last) cursor = last.provId;
      else if (watermark > cursor) cursor = watermark;
    }
    const receiptId = writeReceipt(this.db.journal, {
      grantId: null,
      invocationId: null,
      action: 'read',
      objectType: 'consent.provenance',
      objectId: null,
      purpose: request.purpose,
      decision: 'allow',
      detail: { entities: request.entities, rowCount: changes.length },
    });
    return { changes, cursor, receiptId };
  }

  /** Typed-command invocation: the only write path (rule R04). */
  invoke(cred: Credential, rawRequest: InvokeRequest): InvokeOutcome {
    const identity = this.identify(cred);
    // Purposes are off the critical path (issue #306 decision 4): a caller
    // that names none rides the default; the journal records what applied.
    const request = { ...rawRequest, purpose: rawRequest.purpose ?? DEFAULT_PURPOSE };
    // The demo register is the owner loading a scenario — no app or agent
    // ever mints demo data (a granted caller marking real-looking rows as
    // purgeable would be an integrity hole, not a feature).
    if (request.demo && identity.kind !== 'owner-device') {
      const receiptId = writeReceipt(this.db.journal, {
        grantId: null,
        invocationId: null,
        action: `act ${request.command}`,
        objectType: 'agent.command',
        objectId: null,
        purpose: request.purpose,
        decision: 'deny',
        detail: { failing: 'demo register is owner-only' },
      });
      return { status: 'denied', receiptId, reason: 'demo register is owner-only' };
    }
    const command = lookupCommand(this.db.vault, request.command);
    if (!command || !this.commands.has(request.command)) {
      const receiptId = writeReceipt(this.db.journal, {
        grantId: null,
        invocationId: null,
        action: `act ${request.command}`,
        objectType: 'agent.command',
        objectId: null,
        purpose: request.purpose,
        decision: 'deny',
        detail: { failing: 'unknown command' },
      });
      return { status: 'denied', receiptId, reason: `unknown command ${request.command}` };
    }

    const consent = evaluateConsent(
      this.db.vault,
      identity,
      command.owner_schema,
      request.command.split('.')[1] ?? '',
      'act',
      request.purpose,
    );
    if (consent.decision === 'deny') {
      const receiptId = writeReceipt(this.db.journal, {
        grantId: consent.grantId,
        invocationId: null,
        action: `act ${request.command}`,
        objectType: 'agent.command',
        objectId: command.command_id,
        purpose: request.purpose,
        decision: 'deny',
        detail: { failing: consent.failing },
      });
      return { status: 'denied', receiptId, reason: consent.failing };
    }

    if (request.intentId && identity.kind === 'app') {
      const intent = this.db.vault
        .prepare(
          `SELECT outcome.device_id, app.app_id AS enrolled_app_id
             FROM replica_intent_outcome AS outcome
             JOIN consent_app AS app ON app.name = outcome.app_id
            WHERE outcome.intent_id = ?`,
        )
        .get(request.intentId) as { device_id: string; enrolled_app_id: string } | undefined;
      if (
        !intent ||
        !request.intentDeviceId ||
        intent.device_id !== request.intentDeviceId ||
        intent.enrolled_app_id !== identity.callerId
      ) {
        throw new GatewayError(
          'contract',
          `replica intent ${request.intentId} is not owned by this device and app`,
        );
      }
    }

    const invocationAlreadyExists = request.invocationId
      ? assertInvocationIdentity(
          this.db,
          request.invocationId,
          command.command_id,
          identity.callerId,
          consent.grantId,
        )
      : false;
    const replayed = request.invocationId
      ? replayInvocation(this.db, request.invocationId, {
          deferCommitSettlement: this.activeBatchInvocationIds !== undefined,
        })
      : null;
    if (replayed) return this.trackBatchInvocation(replayed);

    // Confirmation routing (issue #306 decision 2, amending #294 decision 4):
    // an installed caller's declared commands execute under the install-time
    // grant — risk is a salience marker in the journal, never a park trigger.
    // Only a Tier 3/4 command (`confirm: true` → capability row) parks, and
    // it parks for EVERY non-owner caller, regardless of ceiling.
    const sealedInput = this.commands.get(request.command)?.sealedInput ?? [];
    const capability = this.db.vault
      .prepare(`SELECT requires_confirmation FROM agent_capability WHERE command_id = ?`)
      .get(command.command_id) as { requires_confirmation: number } | undefined;
    if (identity.kind !== 'owner-device' && capability?.requires_confirmation === 1) {
      const invocationId = request.invocationId ?? uuidv7();
      if (!invocationAlreadyExists) {
        insertInvocation(
          this.db,
          { ...request, invocationId },
          command,
          identity,
          consent.grantId,
          'proposed',
          invocationId,
          sealedInput,
        );
      }
      const parkedAt = nowIso();
      const reason = `${command.name} requires owner confirmation (loud on purpose)`;
      saveDurableParkedPayload(this.db, {
        invocationId,
        ...(request.intentId ? { intentId: request.intentId } : {}),
        identity,
        request: { ...request, invocationId },
        grantId: consent.grantId,
        commandId: command.command_id,
        commandName: command.name,
        reason,
        parkedAt,
      });
      return {
        status: 'parked',
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
        consent.grantId,
        'proposed',
        undefined,
        sealedInput,
      );
    if (request.invocationId && !invocationAlreadyExists) {
      insertInvocation(
        this.db,
        { ...request, invocationId },
        command,
        identity,
        consent.grantId,
        'proposed',
        invocationId,
        sealedInput,
      );
    }
    return this.trackBatchInvocation(
      runContractAndExecute(
        this.db,
        this.commands,
        identity,
        request,
        command,
        consent,
        invocationId,
        undefined,
        {
          deferCommitSettlement: this.activeBatchInvocationIds !== undefined,
          deferReplicaNotify: this.activeBatchInvocationIds !== undefined,
        },
      ),
    );
  }

  /** Owner decision on a parked invocation (confirmation routing duty). */
  confirm(cred: Credential, invocationId: string, approve: boolean): InvokeOutcome {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner confirms parked invocations');
    // Journal denial commits before vault settlement. A crash in that gap
    // leaves the encrypted payload present, but it is no longer executable:
    // any retry (even an accidental approve) finishes the original denial.
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
                  status: 'denied',
                  invocationId,
                  reason: priorDenial.reason,
                },
              }
            : undefined,
        );
      }
      return { status: 'denied', ...priorDenial };
    }
    const entry = readDurableParkedPayload(this.db, invocationId);
    if (!entry) throw new GatewayError('contract', `no parked invocation ${invocationId}`);
    const replayed = replayInvocation(this.db, invocationId);
    if (replayed?.status === 'replayed') {
      settleDurableParkedPayload(
        this.db,
        invocationId,
        entry.intentId
          ? {
              intentId: entry.intentId,
              outcome: { status: 'executed', invocationId },
            }
          : undefined,
      );
      return replayed;
    }
    const command = lookupCommand(this.db.vault, entry.commandName);
    if (
      !command ||
      command.command_id !== entry.commandId ||
      !this.commands.has(entry.commandName)
    ) {
      throw new GatewayError('contract', `handler missing for parked command ${entry.commandName}`);
    }
    // A durable confirmation may outlive the grant that originally admitted
    // it. Re-check at decision time so a crash between revoking the grant and
    // deleting its parked payload can never let a later approval execute.
    const decisionAt = nowIso();
    const grantStillActive =
      entry.grantId === null ||
      this.db.vault
        .prepare(
          `SELECT 1 AS active FROM consent_access_grant
            WHERE grant_id = ? AND status = 'active' AND revoked_at IS NULL
              AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .get(entry.grantId, decisionAt) !== undefined;
    if (!approve || !grantStillActive) {
      const denialReason = approve ? 'consent grant no longer active' : 'owner denied confirmation';
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
                status: 'denied',
                invocationId,
                reason: denialReason,
              },
            }
          : undefined,
      );
      return { status: 'denied', ...denial };
    }
    const consent: ConsentAllow = {
      decision: 'allow',
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
      consent,
      invocationId,
      { confirmedBy: owner.partyId, confirmedAt: nowIso() },
    );
    settleDurableParkedPayload(
      this.db,
      invocationId,
      entry.intentId
        ? {
            intentId: entry.intentId,
            outcome: {
              status:
                outcome.status === 'executed' || outcome.status === 'replayed'
                  ? 'executed'
                  : outcome.status,
              invocationId,
              ...('reason' in outcome ? { reason: outcome.reason } : {}),
            },
          }
        : undefined,
    );
    return outcome;
  }

  /** Standing duty: revocation cascade — owner-only, instant and total. */
  revokeGrant(cred: Credential, grantId: string): RevocationResult {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner revokes grants');
    const result = revokeGrantCascade(this.db, owner, grantId, (revoked) => {
      let invocationIds: string[];
      this.db.vault.exec('BEGIN IMMEDIATE');
      try {
        const parked = listDurableParkedPayloads(this.db).filter(
          (entry) => entry.grantId === revoked,
        );
        invocationIds = deleteDurableParkedPayloadsForGrant(this.db, revoked);
        for (const entry of parked) {
          if (!entry.intentId) continue;
          transitionReplicaIntentOutcomeInTransaction(this.db.vault, entry.intentId, {
            status: 'failed',
            invocationId: entry.invocationId,
            reason: 'consent grant revoked while awaiting confirmation',
          });
        }
        this.db.vault.exec('COMMIT');
      } catch (error) {
        this.db.vault.exec('ROLLBACK');
        throw error;
      }
      for (const invocationId of invocationIds) {
        setInvocationStatus(this.db, invocationId, 'failed');
      }
      return invocationIds.length;
    });
    // A retained band's write trio goes with the app's access.
    if (result.extRetained.length > 0 && result.appId) {
      this.deregisterExtCommands(result.appId);
    }
    return result;
  }

  /** Standing duty: lifecycle sweep — purge_at deletions, grant/share expiry. */
  sweep(cred: Credential): SweepResult {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner runs sweeps');
    const result = sweepLifecycle(this.db, owner);
    // Near-duplicate cluster projection (issue #352 phase 3/4) — a cheap,
    // fully rebuildable recompute; riding the same standing clock as
    // everything else in duties.ts keeps it fresh without a bespoke timer.
    recomputeDuplicateClusters(this.db.vault);
    // Device work rides the same bounded standing clock: seed jobs for old
    // video/audio/PDF content and clear vanished ownership so a gateway
    // backstop that looks for NULL leases can resume immediately.
    releaseExpiredEnrichmentLeases(this.db.vault);
    drainSatisfiedEnrichmentRequests(this.db.vault);
    queueMissingDeviceEnrichmentBacklog(this.db.vault, {
      newId: () => uuidv7(),
      requestedAt: nowIso(),
      limit: 100,
    });
    return result;
  }

  /**
   * View service: register a declarative app view. Apps register their own;
   * the owner may register on an app's behalf by passing appId.
   */
  registerView(
    cred: Credential,
    options: { name: string; baseEntity: string; definition: ViewDefinition; appId?: string },
  ): string {
    const identity = this.identify(cred);
    let appId: string;
    if (identity.kind === 'app') {
      appId = identity.callerId;
    } else if (identity.kind === 'owner-device' && options.appId) {
      appId = options.appId;
    } else {
      throw new GatewayError(
        'consent',
        'views belong to apps: call as the app or as the owner with appId',
      );
    }
    return registerAppView(this.db, {
      appId,
      name: options.name,
      baseEntity: options.baseEntity,
      definition: options.definition,
    });
  }

  /** View service: execute a registered view, clamped to the app's scopes. */
  queryView(cred: Credential, viewName: string, purpose: string, appId?: string): ViewResult {
    const identity = this.identify(cred);
    let owningApp: string;
    if (identity.kind === 'app') {
      owningApp = identity.callerId;
    } else if (identity.kind === 'owner-device' && appId) {
      owningApp = appId;
    } else {
      throw new GatewayError(
        'consent',
        'views execute as the owning app (or the owner naming one)',
      );
    }
    return queryAppView(this.db, identity, owningApp, viewName, purpose);
  }

  /** Standing duty: file custody — WAL checkpoint both files. */
  checkpoint(cred: Credential): { vault: string; journal: string } {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner checkpoints');
    return checkpointVault(this.db);
  }

  /** Standing duty: file custody — verifiable consistent backup of both files. */
  backup(cred: Credential, destDir: string): BackupResult {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device') throw new GatewayError('consent', 'only the owner backs up');
    return backupVault(this.db, destDir);
  }

  /**
   * The ext band (issue #286 phase 2). Diff-apply an app's declared
   * extension tables to the live band, keep the typed write trio
   * (`ext.<appId>.insert|update|delete`) registered exactly when the band
   * is non-empty, and receipt the change. Owner-only: DDL comes from the
   * manifest through the host, never from the app.
   */
  applyAppExt(
    cred: Credential,
    appId: string,
    tables: ExtTableSpec[],
  ): ExtApplyOutcome & {
    receiptId: string;
  } {
    const owner = this.requireOwner(cred, 'only the owner applies ext bands');
    const outcome = applyExtBand(this.db, appId, tables, 'live');
    if (tables.length > 0) this.registerExtCommands(appId);
    else this.deregisterExtCommands(appId);
    const receiptId = this.receiptExt(owner, appId, 'consent.app_ext_apply', {
      band: 'live',
      ...outcome,
    });
    return { ...outcome, receiptId };
  }

  /**
   * Ensure the app's draft band matches the specs: first call seeds from
   * live rows, later calls diff-apply and keep draft rows. `reset` drops
   * the band first for a fresh live snapshot.
   */
  seedAppExtDraft(
    cred: Credential,
    appId: string,
    tables: ExtTableSpec[],
    opts?: { reset?: boolean },
  ): ExtApplyOutcome & {
    receiptId: string;
  } {
    const owner = this.requireOwner(cred, 'only the owner seeds draft bands');
    if (opts?.reset) dropExtBand(this.db, appId, 'draft');
    const outcome = seedExtDraft(this.db, appId, tables);
    const receiptId = this.receiptExt(owner, appId, 'consent.app_ext_draft_seed', {
      band: 'draft',
      ...outcome,
    });
    return { ...outcome, receiptId };
  }

  /** Discard the app's draft band (session close / reset). */
  dropAppExtDraft(cred: Credential, appId: string): { dropped: string[]; receiptId: string } {
    const owner = this.requireOwner(cred, 'only the owner drops draft bands');
    const dropped = dropExtBand(this.db, appId, 'draft');
    const receiptId = this.receiptExt(owner, appId, 'consent.app_ext_draft_drop', { dropped });
    return { dropped, receiptId };
  }

  /** Uninstall default: data retained, commands deregistered, draft gone. */
  retainAppExt(cred: Credential, appId: string): { retained: string[]; receiptId: string } {
    const owner = this.requireOwner(cred, 'only the owner retires ext bands');
    const retained = retainExtBand(this.db, appId);
    this.deregisterExtCommands(appId);
    const receiptId = this.receiptExt(owner, appId, 'consent.app_ext_retain', { retained });
    return { retained, receiptId };
  }

  /** Owner purge: both bands dropped, registry rows gone, refs swept. */
  purgeAppExt(cred: Credential, appId: string): { purged: string[]; receiptId: string } {
    const owner = this.requireOwner(cred, 'only the owner purges ext bands');
    const purged = purgeExtBand(this.db, appId);
    this.deregisterExtCommands(appId);
    const receiptId = this.receiptExt(owner, appId, 'consent.app_ext_purge', { purged });
    return { purged, receiptId };
  }

  /** Re-arm the write trios for every app with an active band (host boot). */
  registerAllExtCommands(): void {
    for (const appId of extAppIds(this.db.vault)) this.registerExtCommands(appId);
  }

  private registerExtCommands(appId: string): void {
    for (const def of extCommandDefinitions(appId)) this.registerCommand(def);
  }

  private deregisterExtCommands(appId: string): void {
    for (const name of extCommandNames(appId)) this.deregisterCommand(name);
  }

  /** Remove a command's contract row, capability and handler. */
  deregisterCommand(name: string): void {
    const existing = lookupCommand(this.db.vault, name);
    if (existing) {
      this.db.vault
        .prepare('DELETE FROM agent_capability WHERE command_id = ?')
        .run(existing.command_id);
      this.db.vault
        .prepare('DELETE FROM agent_command WHERE command_id = ?')
        .run(existing.command_id);
    }
    this.commands.delete(name);
  }

  private requireOwner(cred: Credential, refusal: string): Identity {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device') throw new GatewayError('consent', refusal);
    return owner;
  }

  private receiptExt(
    owner: Identity,
    appId: string,
    action: string,
    detail: Record<string, unknown>,
  ): string {
    return writeReceipt(this.db.journal, {
      grantId: null,
      invocationId: null,
      action: `act ${action}`,
      objectType: 'consent.app',
      objectId: appId,
      purpose: null,
      decision: 'allow',
      detail: { ...detail, by: owner.partyId },
    });
  }

  /**
   * Purge demo data (issue #290 phase 1) — whole vault or one app's
   * scenario. Owner-only, receipted; rows a non-demo FK still holds are
   * reported blocked, never force-deleted.
   */
  purgeDemo(cred: Credential, appId?: string): DemoPurgeResult {
    const owner = this.requireOwner(cred, 'only the owner purges demo data');
    return purgeDemoRows(this.db, owner, appId);
  }

  /** Seeded-row counts per app — the "demo data present" surface. */
  demoStatus(cred: Credential): { appId: string; rows: number }[] {
    this.requireOwner(cred, 'only the owner inspects demo status');
    return demoStatus(this.db);
  }

  /**
   * File-drop customs (issue #290 phase 2): stage a dropped file into a
   * reviewable draft batch on its (kind, filename) connection. Nothing
   * touches a domain table until the owner publishes.
   */
  stageImportFile(cred: Credential, options: StageFileOptions): StageFileResult {
    const owner = this.requireOwner(cred, 'only the owner imports (v0)');
    return stageFile(this.db, owner, options);
  }

  /** Publish a reviewed draft batch — creates/updates land, receipted. */
  publishImport(cred: Credential, batchId: string): PublishResult {
    const owner = this.requireOwner(cred, 'only the owner publishes imports (v0)');
    return publishBatch(this.db, owner, batchId, PUBLISHERS);
  }

  /** Discard a draft batch — rows dropped, nothing published. */
  discardImport(cred: Credential, batchId: string): { receiptId: string } {
    const owner = this.requireOwner(cred, 'only the owner discards imports (v0)');
    return discardBatch(this.db, owner, batchId);
  }

  /**
   * Blob ingress (issue #296 §3): hash raw bytes into the local CAS and
   * record a staging row. NOT a vault write — no receipt, no content item;
   * the command that claims the sha (`core.attach` / `core.add_document` /
   * `media.add_asset` with `staged_sha`) is the write, and mints the
   * receipt. Unclaimed stages sweep after the TTL. Any caller that may act
   * can stage; claiming is where consent bites.
   */
  stageBlob(cred: Credential, options: Omit<StageBlobOptions, 'stagedBy'>): StagedBlob {
    const identity = this.identify(cred);
    if (!identity.mayAct) {
      throw new GatewayError('consent', 'readonly devices stage nothing');
    }
    return stageBlobBytes(this.db, { ...options, stagedBy: identity.callerId });
  }

  /**
   * Blob egress resolution (issue #296 §5): consent (read on
   * core.content_item, receipted) plus the DERIVED reachability rule — the
   * bytes serve only when some edge in the model claims them. Returns
   * resolution metadata; the transport streams bytes from custody itself
   * (`db.blobs.open`), so Range never crosses this boundary.
   */
  resolveBlob(
    cred: Credential,
    contentId: string,
    options: { variant?: string; purpose?: string } = {},
  ): BlobResolveOutcome & { receiptId?: string } {
    const identity = this.identify(cred);
    const purpose = options.purpose ?? 'dpv:ServiceProvision';
    const consent = evaluateConsent(
      this.db.vault,
      identity,
      'core',
      'content_item',
      'read',
      purpose,
    );
    if (consent.decision === 'deny') {
      const receiptId = writeReceipt(this.db.journal, {
        grantId: consent.grantId,
        invocationId: null,
        action: 'read',
        objectType: 'core.content_item',
        objectId: contentId,
        purpose,
        decision: 'deny',
        detail: { failing: consent.failing, surface: 'blob' },
      });
      throw new GatewayError('consent', `deny (receipt ${receiptId}): ${consent.failing}`);
    }
    const outcome = resolveServableBlob(this.db.vault, contentId, options.variant);
    const receiptId = writeReceipt(this.db.journal, {
      grantId: consent.grantId,
      invocationId: null,
      action: 'read',
      objectType: 'core.content_item',
      objectId: contentId,
      purpose,
      decision: outcome.status === 'ok' ? 'allow' : 'deny',
      detail: {
        surface: 'blob',
        variant: options.variant ?? 'original',
        ...(outcome.status === 'ok' ? {} : { failing: outcome.status }),
      },
    });
    return { ...outcome, receiptId };
  }

  /**
   * Agent content access (issue #299 §2, the #296 §7 seam): the size-bounded
   * byte primitive enrichers and the assistant read through. Structural
   * rule: DERIVATIVES EGRESS, NEVER ORIGINALS — the surface only spells
   * `thumb`, `preview` and `text`. Consent is the same read evaluation the
   * blob routes run, and every fetch (allow or deny) is receipted — the
   * "multimodal hand-off is its own consent event" decision, made code.
   */
  async contentForAgent(
    cred: Credential,
    request: { contentId: string; variant: string; maxBytes?: number; purpose?: string },
  ): Promise<AgentContentOutcome & { receiptId: string }> {
    const identity = this.identify(cred);
    const purpose = request.purpose ?? 'dpv:ServiceProvision';
    if (!(AGENT_CONTENT_VARIANTS as readonly string[]).includes(request.variant)) {
      throw new GatewayError(
        'consent',
        `variant "${request.variant}" is not agent-readable — derivatives egress, never originals (issue #299): ${AGENT_CONTENT_VARIANTS.join(', ')}`,
      );
    }
    const consent = evaluateConsent(
      this.db.vault,
      identity,
      'core',
      'content_item',
      'read',
      purpose,
    );
    if (consent.decision === 'deny') {
      const receiptId = writeReceipt(this.db.journal, {
        grantId: consent.grantId,
        invocationId: null,
        action: 'read',
        objectType: 'core.content_item',
        objectId: request.contentId,
        purpose,
        decision: 'deny',
        detail: { failing: consent.failing, surface: 'agent-content', variant: request.variant },
      });
      throw new GatewayError('consent', `deny (receipt ${receiptId}): ${consent.failing}`);
    }
    const outcome = await resolveAgentContent(
      this.db,
      request.contentId,
      request.variant as AgentContentVariant,
      request.maxBytes,
    );
    const receiptId = writeReceipt(this.db.journal, {
      grantId: consent.grantId,
      invocationId: null,
      action: 'read',
      objectType: 'core.content_item',
      objectId: request.contentId,
      purpose,
      decision: outcome.status === 'ok' ? 'allow' : 'deny',
      detail: {
        surface: 'agent-content',
        variant: request.variant,
        by: identity.callerId,
        ...(outcome.status === 'ok' ? {} : { failing: outcome.status }),
      },
    });
    return { ...outcome, receiptId };
  }

  /**
   * Standing duty: blob replication + reconciliation (issue #296 §6).
   * Pushes local bytes the remote tier lacks, deletes remote orphans
   * nothing claims, and reports shas missing from BOTH tiers (integrity
   * errors are surfaced, never papered over). Owner-only, receipted.
   */
  async sweepBlobs(
    cred: Credential,
    options?: {
      skipOrphanDelete?: boolean;
      extraLiveRoots?: ReadonlySet<string>;
      graceWindowMs?: number;
    },
  ): Promise<ReconcileResult & { receiptId: string }> {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner sweeps blob custody');
    // Archived journal segments are claimed by the manifest chain, not by
    // any core_content_item row — without this union the reconcile sweep
    // would delete their remote replicas as orphans (issue #367 §E2).
    const live = liveBlobShas(this.db.vault);
    for (const sha of archivedSegmentShas(this.db.journal)) live.add(sha);
    // Conversation-ledger archive segments are claimed the same way (issue #438
    // decision 6) — a pruned segment is the ONLY copy of its rows, so it must
    // read as reachable or the sweep would delete the only durable copy.
    for (const sha of conversationArchiveShas(this.db.journal)) live.add(sha);
    // Retained-snapshot GC roots (issue #436 §6) pin remote objects the live
    // model no longer claims but a recovery-to-N would still need. They protect
    // from the orphan delete without joining `live` (which would spuriously
    // re-push a remote-only original the local tier does not hold).
    const result = await this.db.blobs.reconcile(live, {
      ...(options?.skipOrphanDelete ? { skipOrphanDelete: true } : {}),
      ...(options?.extraLiveRoots ? { extraLiveRoots: options.extraLiveRoots } : {}),
      // Orphan-grace window (issue #439 R4): the recovery window N, as ms. The
      // gateway resolves it from the provider's retention ladder; the delete is
      // deferred until an orphan has been observed for longer than N.
      ...(options?.graceWindowMs !== undefined ? { graceWindowMs: options.graceWindowMs } : {}),
    });
    // Refresh the app-readable custody-state mirror (issue #352 phase 3/4)
    // AFTER reconcile — the snapshot reflects the post-sweep steady state,
    // not a stale pre-sweep gap.
    await refreshCustodyState(this.db);
    // Preview backstop (issue #405 §2): fill missing tiny/medium derivatives
    // for image content a capable client never produced — Takeout imports,
    // weak/old clients, server-side ingestion. Bounded per sweep (cheap edge
    // CPU QoS) and only when the host wired a raster codec (the vault package
    // carries none). Best-effort maintenance: a codec failure is swallowed so
    // it can never fail the custody sweep it rides along with. Real work lives
    // in blob/preview.ts — gateway.ts stays over its line cap on a waiver, so
    // this addition is deliberately a thin call-through.
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
    // Device leases and gateway backstops share the typed derivative row as
    // their completion truth. Once an expired/unowned job's rung exists,
    // close it here so queue depth reflects the actual remaining work.
    drainSatisfiedEnrichmentRequests(this.db.vault);
    // Bounded-cache eviction (issue #405 §3): run LAST, after reconcile has
    // healed the replication index and the preview backstop has generated this
    // sweep's new rungs — so the pass evicts against fresh replication evidence
    // and never sheds a tiny it just made. Sheds replicated LRU mediums/
    // originals until the spool is under budget; pinned tinies, staged bytes and
    // un-replicated last copies are untouchable. The evicted rows read back
    // `remote-only` on the NEXT sweep's `refreshCustodyState` (custody-state.ts
    // doc). No-op when the vault is local-only or the budget isn't exceeded.
    const evicted = this.db.blobs.evictAfterReconcile();
    const receiptId = writeReceipt(this.db.journal, {
      grantId: null,
      invocationId: null,
      action: 'act consent.blob_sweep',
      objectType: 'core.content_item',
      objectId: null,
      purpose: null,
      decision: 'allow',
      detail: {
        orphansDeleted: result.orphansDeleted.length,
        orphansSkipped: result.orphansSkipped.length,
        // Orphans held by the recovery-window grace (issue #439 R4) — deferred,
        // not skipped; they delete on a future sweep once the grace elapses.
        orphansGraceHeld: result.orphansGraceHeld.length,
        replicated: result.replicated.length,
        missing: result.missing,
        // The preview backstop's per-sweep yield (issue #405 §2) — 0 when no
        // codec is wired or no image was missing a rung.
        previewsGenerated,
        // Inline dHash contributions published beside preview rungs.
        phashesGenerated,
        // Inline ThumbHash placeholders published beside preview rungs.
        thumbhashesGenerated,
        // The bounded-cache eviction yield (issue #405 §3) — 0 when the spool
        // is under budget or the vault is local-only.
        evictedBlobs: evicted.evictedBlobs,
        evictedBytes: evicted.evictedBytes,
      },
    });
    return { ...result, receiptId };
  }

  /** Standing duty: ingest customs — ICS events enter through the border post. */
  importIcs(cred: Credential, icsText: string): ImportResult {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner imports (v0)');
    return importIcsEvents(this.db, owner, icsText);
  }

  /** Standing duty: ingest customs — vCards resolve to identities, never duplicates. */
  importVcards(cred: Credential, vcfText: string): ImportResult {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner imports (v0)');
    return importVcardParties(this.db, owner, vcfText);
  }

  /** Standing duty: export & portability — the whole model out, verifiable. */
  exportVault(cred: Credential): { artifact: VaultExport; exportId: string; receiptId: string } {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner exports the vault');
    return exportVault(this.db, owner);
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
      // (issue #293) — sealed inputs ride as hash tokens here too, nested ext
      // secrets included (issue #298 item 9).
      input: redactCommandInput(
        this.db.sealKey,
        p.commandName,
        p.request.input,
        this.commands.get(p.commandName)?.sealedInput ?? [],
        this.db.vault,
      ),
    }));
  }

  /**
   * The requester kind for the approval surface's trust badge — refines
   * `Identity['kind']`'s `'agent'` into `'assistant'` when the credential is
   * the vault assistant's own enrolled identity (`_assistant`,
   * `VaultPlane.invokeAsAssistant`), not an automation's.
   */
  private callerKind(identity: Identity): ParkedCallerKind {
    if (identity.kind !== 'agent') return identity.kind;
    const row = this.db.vault
      .prepare('SELECT host_key FROM agent_agent WHERE agent_id = ?')
      .get(identity.callerId) as { host_key: string } | undefined;
    return row?.host_key === '_assistant' ? 'assistant' : 'agent';
  }

  /** Display name for a parked caller — WHO wants the act, for the owner. */
  private callerName(identity: Identity): string | null {
    if (identity.kind === 'owner-device') return 'owner';
    const byApp = identity.kind === 'app';
    const row = this.db.vault
      .prepare(
        byApp
          ? 'SELECT COALESCE(display_name, name) AS name FROM consent_app WHERE app_id = ?'
          : `SELECT p.display_name AS name FROM agent_agent a
               JOIN core_party p ON p.party_id = a.party_id WHERE a.agent_id = ?`,
      )
      .get(identity.callerId) as { name: string } | undefined;
    return row?.name ?? null;
  }
}

export function createGateway(db: VaultDb): Gateway {
  return new Gateway(db);
}
