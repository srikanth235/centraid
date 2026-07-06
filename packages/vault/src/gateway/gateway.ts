// governance: allow-repo-hygiene file-size-limit the one-door pipeline (§10) — identity → consent → contract → execution → evidence must stay one auditable unit
// The gateway (§10): one door, every request, no exceptions. Sole holder of
// connections; every read and typed command walks identity → consent →
// contract → execution → evidence. It stays a thin, mostly declarative
// interpreter over the consent and capability tables: no domain logic, no
// reasoning, no rendering, no byte custody.

import { nowIso, uuidv7 } from '../ids.js';
import type { VaultDb } from '../db.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import { resolveEntity } from '../schema/tables.js';
import { resolveRefCards, type RefRequest, type ResolveResult } from './cards.js';
import { evaluateConsent, type ConsentAllow } from './consent.js';
import { lookupCommand, type CommandRow } from './contract.js';
import {
  revokeGrantCascade,
  sweepLifecycle,
  type RevocationResult,
  type SweepResult,
} from './duties.js';
import { writeExplanation, writeReceipt } from './evidence.js';
import {
  insertInvocation,
  invocationExists,
  replayInvocation,
  runContractAndExecute,
  setInvocationStatus,
} from './execution.js';
import { applyFieldMask, compileFilters, compileOrderBy } from './filters.js';
import { authenticate } from './identity.js';
import { searchEntity } from './search.js';
import {
  runReadOnlySql,
  VAULT_SQL_DEFAULT_ROWS,
  type VaultSqlRequest,
  type VaultSqlResult,
} from './sql.js';
import { importIcsEvents, importVcardParties, type ImportResult } from '../ingest/import.js';
import { demoStatus, purgeDemoRows, type DemoPurgeResult } from './demo.js';
import { pkColumn } from './execution.js';
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
import type {
  ChangeEntry,
  ChangesRequest,
  ChangesResult,
  CommandDefinition,
  Credential,
  Identity,
  InvokeOutcome,
  InvokeRequest,
  ParkedSummary,
  ReadRequest,
  ReadResult,
  Risk,
  SearchRequest,
  SearchResult,
} from './types.js';
import { GatewayError } from './types.js';

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

interface Parked {
  identity: Identity;
  request: InvokeRequest;
  grantId: string | null;
  command: CommandRow;
  parkedAt: string;
}

export class Gateway {
  private readonly handlers = new Map<string, CommandDefinition['handler']>();
  /** The pause between draft and send is gateway state (§10 standing duties). */
  private readonly parked = new Map<string, Parked>();

  constructor(private readonly db: VaultDb) {}

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
    if (existing) {
      this.db.vault
        .prepare(
          `UPDATE agent_command SET name=?, owner_schema=?, input_schema_json=?, output_schema_json=?,
             preconditions_json=?, postconditions_json=?, idempotency=?, risk=?, ontology_version=?
           WHERE command_id=?`,
        )
        .run(...params, commandId);
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
        .run(uuidv7(), def.ownerSchema, commandId, def.name, def.risk === 'high' ? 1 : 0);
    }
    this.handlers.set(def.name, def.handler);
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
  read(cred: Credential, request: ReadRequest): ReadResult {
    const identity = this.identify(cred);
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
    // Ordering is what turns a bounded read into a RECENT window (issue
    // #262) — validated like a filter column, so it can't widen anything.
    const order = compileOrderBy(target, ref.physical, request.orderBy);
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
  search(cred: Credential, request: SearchRequest): SearchResult {
    const identity = this.identify(cred);
    return searchEntity(this.db, identity, request);
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
  changes(cred: Credential, request: ChangesRequest): ChangesResult {
    const identity = this.identify(cred);
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
  invoke(cred: Credential, request: InvokeRequest): InvokeOutcome {
    const identity = this.identify(cred);
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
    const replayed = request.invocationId ? replayInvocation(this.db, request.invocationId) : null;
    if (replayed) return replayed;

    const command = lookupCommand(this.db.vault, request.command);
    if (!command || !this.handlers.has(request.command)) {
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

    // Risk vs ceiling: above it, the request parks for owner confirmation
    // instead of executing (§10 standing duty: confirmation routing).
    if (
      identity.riskCeiling !== 'owner' &&
      RISK_RANK[command.risk] > RISK_RANK[identity.riskCeiling]
    ) {
      const invocationId = insertInvocation(
        this.db,
        request,
        command,
        identity,
        consent.grantId,
        'proposed',
      );
      this.parked.set(invocationId, {
        identity,
        request: { ...request, invocationId },
        grantId: consent.grantId,
        command,
        parkedAt: nowIso(),
      });
      return {
        status: 'parked',
        invocationId,
        reason: `risk ${command.risk} exceeds ceiling ${identity.riskCeiling}`,
      };
    }

    const invocationId =
      request.invocationId ??
      insertInvocation(this.db, request, command, identity, consent.grantId, 'proposed');
    if (request.invocationId && !invocationExists(this.db, invocationId)) {
      insertInvocation(
        this.db,
        { ...request, invocationId },
        command,
        identity,
        consent.grantId,
        'proposed',
        invocationId,
      );
    }
    return runContractAndExecute(
      this.db,
      this.handlers,
      identity,
      request,
      command,
      consent,
      invocationId,
    );
  }

  /** Owner decision on a parked invocation (confirmation routing duty). */
  confirm(cred: Credential, invocationId: string, approve: boolean): InvokeOutcome {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner confirms parked invocations');
    const entry = this.parked.get(invocationId);
    if (!entry) throw new GatewayError('contract', `no parked invocation ${invocationId}`);
    this.parked.delete(invocationId);
    if (!approve) {
      setInvocationStatus(this.db, invocationId, 'failed');
      const receiptId = writeReceipt(this.db.journal, {
        grantId: entry.grantId,
        invocationId,
        action: `act ${entry.command.name}`,
        objectType: 'agent.command',
        objectId: entry.command.command_id,
        purpose: entry.request.purpose,
        decision: 'deny',
        detail: {
          failing: 'owner denied confirmation',
          confirmedBy: owner.partyId,
          confirmedAt: nowIso(),
        },
      });
      writeExplanation(
        this.db.journal,
        invocationId,
        `Owner denied ${entry.command.name} at confirmation.`,
      );
      return { status: 'denied', invocationId, receiptId, reason: 'owner denied confirmation' };
    }
    const consent: ConsentAllow = {
      decision: 'allow',
      grantId: entry.grantId,
      rowFilter: [],
      fieldMask: null,
    };
    return runContractAndExecute(
      this.db,
      this.handlers,
      entry.identity,
      entry.request,
      entry.command,
      consent,
      invocationId,
      { confirmedBy: owner.partyId, confirmedAt: nowIso() },
    );
  }

  /** Standing duty: revocation cascade — owner-only, instant and total. */
  revokeGrant(cred: Credential, grantId: string): RevocationResult {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner revokes grants');
    const result = revokeGrantCascade(this.db, owner, grantId, (revoked) => {
      let dropped = 0;
      for (const [invocationId, entry] of this.parked) {
        if (entry.grantId === revoked) {
          this.parked.delete(invocationId);
          setInvocationStatus(this.db, invocationId, 'failed');
          dropped += 1;
        }
      }
      return dropped;
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
    return sweepLifecycle(this.db, owner);
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
    this.handlers.delete(name);
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
    return [...this.parked.entries()].map(([invocationId, p]) => ({
      invocationId,
      command: p.command.name,
      parkedAt: p.parkedAt,
      callerKind: p.identity.kind,
      caller: this.callerName(p.identity),
      input: p.request.input,
    }));
  }

  /** Display name for a parked caller — WHO wants the act, for the owner. */
  private callerName(identity: Identity): string | null {
    if (identity.kind === 'owner-device') return 'owner';
    const byApp = identity.kind === 'app';
    const row = this.db.vault
      .prepare(
        byApp
          ? 'SELECT name FROM consent_app WHERE app_id = ?'
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
