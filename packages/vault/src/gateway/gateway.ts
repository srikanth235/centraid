// The gateway (§10): one door, every request, no exceptions. Sole holder of
// connections; every read and typed command walks identity → consent →
// contract → execution → evidence. It stays a thin, mostly declarative
// interpreter over the consent and capability tables: no domain logic, no
// reasoning, no rendering, no byte custody.

import { nowIso, uuidv7 } from '../ids.js';
import type { VaultDb } from '../db.js';
import { ONTOLOGY_VERSION } from '../schema/migrate.js';
import { resolveEntity } from '../schema/tables.js';
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
import { applyFieldMask, compileFilters } from './filters.js';
import { authenticate } from './identity.js';
import { importIcsEvents, importVcardParties, type ImportResult } from '../ingest/import.js';
import { backupVault, checkpointVault, createAppExt, type BackupResult } from './custody.js';
import { exportVault, type VaultExport } from './portability.js';
import { queryAppView, registerAppView, type ViewDefinition, type ViewResult } from './views.js';
import type {
  CommandDefinition,
  Credential,
  Identity,
  InvokeOutcome,
  InvokeRequest,
  ReadRequest,
  ReadResult,
  Risk,
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
    const ref = resolveEntity(request.entity);
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
    const grantFilter = compileFilters(target, ref.physical, consent.rowFilter, now);
    const callerFilter = compileFilters(target, ref.physical, request.where ?? [], now);
    const select = applyFieldMask(target, ref.physical, consent.fieldMask);
    const limit = Math.min(Math.max(request.limit ?? 1000, 1), 10_000);
    const rows = target
      .prepare(
        `SELECT ${select} FROM "${ref.physical}" WHERE ${grantFilter.where} AND ${callerFilter.where} LIMIT ${limit}`,
      )
      .all(...grantFilter.params, ...callerFilter.params) as Record<string, unknown>[];
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

  /** Typed-command invocation: the only write path (rule R04). */
  invoke(cred: Credential, request: InvokeRequest): InvokeOutcome {
    const identity = this.identify(cred);
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
    return revokeGrantCascade(this.db, owner, grantId, (revoked) => {
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

  /** Standing duty: file custody — create an app's extension file. */
  createAppExt(cred: Credential, appId: string): string {
    const owner = this.identify(cred);
    if (owner.kind !== 'owner-device')
      throw new GatewayError('consent', 'only the owner creates appext files');
    return createAppExt(this.db, appId);
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

  listParked(): { invocationId: string; command: string; parkedAt: string }[] {
    return [...this.parked.entries()].map(([invocationId, p]) => ({
      invocationId,
      command: p.command.name,
      parkedAt: p.parkedAt,
    }));
  }
}

export function createGateway(db: VaultDb): Gateway {
  return new Gateway(db);
}
