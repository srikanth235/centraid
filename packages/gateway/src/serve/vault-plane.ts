// governance: allow-repo-hygiene file-size-limit one cohesive plane (mount + both bridge planes + workspace accessors, #280; #282 adds anchorAsOwner, a one-line delegation like its link/unlink siblings); pending split of the bridge executors into a sibling module
/*
 * The vault plane (duaility §12) — the gateway's mount of the owner's
 * personal vault (`@centraid/vault`) beside the per-app data silos.
 *
 * The gateway process is the sole holder of the vault connection. Apps
 * reach it only through `ctx.vault`, whose worker messages land in
 * `bridgeFor(appId)`: the running app is resolved to its enrolled
 * `consent.app` credential HERE, host-side — no signing key ever crosses
 * into a handler worker. Consent, contracts, receipts and provenance are
 * the vault gateway's own five-stage pipeline; this module adds nothing
 * on top and takes nothing away.
 *
 * Lifecycle: `openVaultPlane()` opens/creates the two SQLite files under
 * the vault's directory (one per vault, handed out by the vault registry),
 * bootstraps the owner idempotently (recovery re-derives
 * the owner-device credential from the model), and registers the four
 * foundation domains. `start()` begins the sweep clock; `stop()` sweeps
 * the clock down, WAL-checkpoints, and closes the files.
 */

import {
  assertExtSchemaOwnership,
  buildAssistantContext,
  createGateway,
  createGrant,
  ensureAgentEnrolled,
  ensureAppEnrolled,
  ensureVaultBootstrapped,
  GatewayError,
  listActiveAgentGrants,
  listActiveGrants,
  listEnrolledAgents,
  listEnrolledApps,
  lookupAgentByName,
  lookupAppByName,
  markAgentRevoked,
  markAppRevoked,
  openVaultDb,
  purposeConceptId,
  renameVault,
  readVaultPresentation,
  updateVaultPresentation,
  type VaultPresentation,
  registerAttachmentCommands,
  registerBusinessCommands,
  registerDocumentCommands,
  registerFinanceCommands,
  registerHealthCommands,
  registerHomeCommands,
  registerLockerCommands,
  registerKnowledgeCommands,
  registerLinkCommands,
  registerMediaCommands,
  registerPartyCommands,
  registerPeopleCommands,
  registerScheduleCommands,
  registerSocialCommands,
  registerTallyCommands,
  registerTaskCommands,
  type AgentSummary,
  type AppSummary,
  type ChangesRequest,
  type Credential,
  type Gateway as VaultGateway,
  type GrantSummary,
  type HostBootstrap,
  type InvokeOutcome,
  type InvokeRequest,
  type ParkedSummary,
  type ReadRequest,
  type RefRequest,
  type RevocationResult,
  type ScopeSpec,
  type SearchRequest,
  type SweepResult,
  type VaultDb,
  type VaultSqlResult,
  type ResolveResult,
  type ExtApplyOutcome,
  type ExtTableSpec,
} from '@centraid/vault';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  openTranscriptsDb,
  type RuntimeLogger,
  type VaultBridge,
  type VaultCallResult,
  type VaultWorkspace,
} from '@centraid/app-engine';
import {
  anchorAsOwner,
  linkAsOwner,
  pickEntities,
  unlinkAsOwner,
  type AnchorSelector,
  type LinkInput,
  type PickerHit,
  type PickerRequest,
} from './vault-picker.js';

export interface VaultPlaneOptions {
  /** Directory holding `vault.db` + `journal.db`. Created if absent. */
  dir: string;
  logger: RuntimeLogger;
  /** Owner display name used only on first boot. */
  ownerName?: string;
  /** Pre-minted vault id used only on first boot (multi-vault hosts name the dir after it). */
  vaultId?: string;
  /** Owner-facing vault name used only on first boot. */
  vaultName?: string;
  /** Sweep cadence for lifecycle duties. Default: hourly. */
  sweepIntervalMs?: number;
}

/** A grant request the owner approves — scopes as the manifest declares them. */
export interface GrantRequest {
  purpose: string;
  scopes: ScopeSpec[];
  expiresAt?: string;
}

/**
 * The shared bridge error contract: a GatewayError maps to its pipeline
 * stage (`VAULT_CONSENT`, `VAULT_CONTRACT`, …), anything else to
 * `VAULT_ERROR`. Both bridge planes (app and agent) speak it.
 */
function asVaultCallResult(fn: () => unknown): VaultCallResult {
  try {
    return { ok: true, result: fn() };
  } catch (err) {
    if (err instanceof GatewayError) {
      return { ok: false, code: `VAULT_${err.stage.toUpperCase()}`, error: err.message };
    }
    return {
      ok: false,
      code: 'VAULT_ERROR',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export class VaultPlane {
  readonly db: VaultDb;
  readonly gateway: VaultGateway;
  readonly boot: HostBootstrap;
  /** The vault's directory — the registry deletes it on vault removal. */
  readonly dir: string;
  private readonly logger: RuntimeLogger;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private displayName: string;
  /** Lazily-opened `transcripts.db` handle — closed with the plane. */
  private transcriptsDb: DatabaseSync | undefined;

  constructor(options: VaultPlaneOptions) {
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 60 * 1000;
    this.dir = options.dir;
    this.db = openVaultDb({ dir: options.dir });
    this.boot = ensureVaultBootstrapped(this.db, {
      ownerName: options.ownerName ?? 'Owner',
      ...(options.vaultId ? { vaultId: options.vaultId } : {}),
      ...(options.vaultName ? { vaultName: options.vaultName } : {}),
    });
    this.displayName = this.boot.displayName;
    this.gateway = createGateway(this.db);
    registerScheduleCommands(this.gateway);
    registerTaskCommands(this.gateway);
    registerSocialCommands(this.gateway);
    registerFinanceCommands(this.gateway);
    registerHealthCommands(this.gateway);
    registerKnowledgeCommands(this.gateway);
    registerBusinessCommands(this.gateway);
    registerAttachmentCommands(this.gateway);
    registerLinkCommands(this.gateway);
    registerPartyCommands(this.gateway);
    registerMediaCommands(this.gateway);
    registerDocumentCommands(this.gateway);
    registerHomeCommands(this.gateway);
    registerPeopleCommands(this.gateway);
    registerLockerCommands(this.gateway);
    registerTallyCommands(this.gateway);
    // Re-arm the ext-band write trios for every installed app that
    // declared extension tables (issue #286 phase 2) — command handlers
    // live in gateway memory, the contract rows in the vault.
    this.gateway.registerAllExtCommands();
    this.logger.info(
      this.boot.fresh
        ? `vault plane: bootstrapped a fresh vault at ${options.dir}`
        : `vault plane: recovered vault ${this.boot.vaultId} at ${options.dir}`,
    );
  }

  /** The owner-device credential the host acts with (confirm/revoke/sweep). */
  get ownerCredential(): Credential {
    return { kind: 'device', deviceId: this.boot.deviceId, deviceKey: this.boot.deviceKey };
  }

  /** The vault's owner-facing name (`core_vault.display_name`). */
  get name(): string {
    return this.displayName;
  }

  /**
   * The vault's workspace (#280 — the vault is the unit): the ledger,
   * per-app data dirs, and runner scratch that live BESIDE the sovereign
   * pair inside this vault's directory. app-engine operates entirely
   * through this view; the registry hands out the active one.
   */
  get workspace(): VaultWorkspace {
    return {
      vaultId: this.boot.vaultId,
      ownerPartyId: this.boot.ownerPartyId,
      appsDir: path.join(this.dir, 'apps'),
      transcripts: () => this.transcripts(),
      transcriptsDbFile: path.join(this.dir, 'transcripts.db'),
      runnerSessionDir: path.join(this.dir, 'runner-sessions'),
    };
  }

  /**
   * Root of this vault's app CODE store (`apps.git` + worktrees) — the
   * gateway constructs a `WorktreeStore` here per vault (#280: each family
   * member builds their own apps; the code travels with the vault).
   */
  get codeStoreRoot(): string {
    return path.join(this.dir, 'code');
  }

  /** Lazily open (and cache) this vault's `transcripts.db`. */
  private transcripts(): DatabaseSync {
    if (this.closed) throw new Error(`vault plane ${this.boot.vaultId} is stopped`);
    if (!this.transcriptsDb) {
      this.transcriptsDb = openTranscriptsDb(path.join(this.dir, 'transcripts.db'));
    }
    return this.transcriptsDb;
  }

  /** Rename the vault (owner act). */
  rename(name: string): void {
    renameVault(this.db, name);
    this.displayName = name;
    this.logger.info(`vault plane: renamed vault ${this.boot.vaultId} to "${name}"`);
  }

  /**
   * The vault's presentation (avatar color / icon / blurb) — owner-facing
   * identity that lives IN the vault (`core_vault.settings_json`), so it
   * travels with an export (#280: profiles are vaults).
   */
  get presentation(): VaultPresentation {
    return readVaultPresentation(this.db);
  }

  /** Merge a presentation patch (owner act); null/empty clears a field. */
  updatePresentation(
    patch: Partial<Record<'color' | 'icon' | 'blurb', string | null>>,
  ): VaultPresentation {
    return updateVaultPresentation(this.db, patch);
  }

  /**
   * Enroll a live app as a `consent.app` row, once. Called on every
   * app-live event; re-publishes are no-ops. Enrollment is identity only —
   * access still requires an owner-approved grant (deny-by-default).
   */
  enrollApp(appId: string): void {
    const enrolled = ensureAppEnrolled(this.db, appId, { origin: 'generated' });
    if (enrolled.created) this.logger.info(`vault plane: enrolled app "${appId}"`);
  }

  /**
   * Enroll an automation app's acting identity as an `agent.agent` row,
   * once (duaility §12: automation fires ride an enrolled agent, not an
   * app credential). Keyed by the Centraid app id, like `enrollApp`.
   * Identity only — authority still requires an owner-approved agent grant.
   */
  enrollAutomationAgent(appId: string): void {
    const enrolled = ensureAgentEnrolled(this.db, appId, { modelRef: 'centraid-automation' });
    if (enrolled.created) this.logger.info(`vault plane: enrolled automation agent "${appId}"`);
  }

  /**
   * Uninstall cascade: revoke every active grant (views invalidated, parked
   * invocations dropped, the ext band RETAINED on the last one — the data
   * is the owner's; purge is a separate explicit act), then retire the
   * enrollment row. Covers both planes of the app's identity — its
   * `consent.app` row and, for automation apps, its `agent.agent` row.
   * Model rows and receipts remain — §11's success test.
   */
  revokeApp(appId: string): { grantsRevoked: number } {
    let revoked = 0;
    const app = lookupAppByName(this.db, appId);
    if (app) {
      for (const grant of listActiveGrants(this.db, app.appId)) {
        const result: RevocationResult = this.gateway.revokeGrant(
          this.ownerCredential,
          grant.grantId,
        );
        revoked += 1;
        this.logger.info(
          `vault plane: revoked grant ${grant.grantId} for "${appId}" ` +
            `(views ${result.viewsRevoked}, parked ${result.parkedDropped})`,
        );
      }
      markAppRevoked(this.db, app.appId);
    }
    const agent = lookupAgentByName(this.db, appId);
    if (agent) {
      for (const grant of listActiveAgentGrants(this.db, agent.partyId)) {
        this.gateway.revokeGrant(this.ownerCredential, grant.grantId);
        revoked += 1;
        this.logger.info(`vault plane: revoked agent grant ${grant.grantId} for "${appId}"`);
      }
      markAgentRevoked(this.db, agent.agentId);
    }
    return { grantsRevoked: revoked };
  }

  /**
   * Owner approval of a requested grant. `purpose` is a DPV notation the
   * vault's seed vocabulary knows; unknown purposes are refused rather
   * than silently minted. An app may request `ext.*` scopes only on its
   * OWN band — `ext.<appId>` — never a sibling's.
   */
  approveGrant(appId: string, request: GrantRequest): string {
    const app = ensureAppEnrolled(this.db, appId, { origin: 'generated' });
    const purpose = purposeConceptId(this.db, request.purpose);
    if (!purpose) throw new Error(`unknown purpose notation "${request.purpose}"`);
    if (request.scopes.length === 0) throw new Error('a grant needs at least one scope');
    for (const scope of request.scopes) assertExtSchemaOwnership(appId, scope.schema);
    return createGrant(this.db, {
      appId: app.appId,
      purposeConceptId: purpose,
      grantedByPartyId: this.boot.ownerPartyId,
      scopes: request.scopes,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    });
  }

  /**
   * Owner approval of an automation's requested grant — the agent-plane
   * mirror of `approveGrant`. The grantee is the agent's party, so the
   * grant matches on `grantee_party_id` in consent evaluation.
   */
  approveAgentGrant(appId: string, request: GrantRequest): string {
    const agent = ensureAgentEnrolled(this.db, appId, { modelRef: 'centraid-automation' });
    const purpose = purposeConceptId(this.db, request.purpose);
    if (!purpose) throw new Error(`unknown purpose notation "${request.purpose}"`);
    if (request.scopes.length === 0) throw new Error('a grant needs at least one scope');
    return createGrant(this.db, {
      granteePartyId: agent.partyId,
      purposeConceptId: purpose,
      grantedByPartyId: this.boot.ownerPartyId,
      scopes: request.scopes,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    });
  }

  /** Enrolled apps with their active grants — the owner consent surface. */
  listApps(): Array<AppSummary & { grants: GrantSummary[] }> {
    return listEnrolledApps(this.db).map((app) => ({
      ...app,
      grants: listActiveGrants(this.db, app.appId),
    }));
  }

  /** Enrolled automation agents with their active grants. */
  listAgents(): Array<AgentSummary & { grants: GrantSummary[] }> {
    return listEnrolledAgents(this.db).map((agent) => ({
      ...agent,
      grants: listActiveAgentGrants(this.db, agent.partyId),
    }));
  }

  /** Revoke one grant by id (owner act; the cascade runs). */
  revokeGrant(grantId: string): RevocationResult {
    return this.gateway.revokeGrant(this.ownerCredential, grantId);
  }

  listParked(): ParkedSummary[] {
    return this.gateway.listParked();
  }

  /**
   * The shell entity picker (issue #272): an OWNER-trust search/browse over
   * the carded entities (implemented in vault-picker.ts), so an app can let
   * the user reference a foreign entity without ever holding browse scopes on
   * that domain — the act of picking is the consent.
   */
  pickEntities(request: PickerRequest): { cards: PickerHit[] } {
    return pickEntities(this.gateway, this.ownerCredential, this.logger, request);
  }

  /**
   * Assert (or end) a link as the owner — the write half of the picker flow
   * (both in vault-picker.ts). The pick already carried the owner's intent,
   * so the shell invokes the link commands with the owner-device credential;
   * the app never needs read scopes on the far domain.
   */
  linkAsOwner(input: LinkInput): InvokeOutcome {
    return linkAsOwner(this.gateway, this.ownerCredential, input);
  }

  unlinkAsOwner(linkId: string): InvokeOutcome {
    return unlinkAsOwner(this.gateway, this.ownerCredential, linkId);
  }

  /**
   * Move or clear a live link's standoff anchor (issue #282) — the
   * re-anchor / re-baseline half of inline references. A locator write, not
   * a new judgment.
   */
  anchorAsOwner(linkId: string, selector: AnchorSelector | null): InvokeOutcome {
    return anchorAsOwner(this.gateway, this.ownerCredential, linkId, selector);
  }

  confirmParked(invocationId: string, approve: boolean): InvokeOutcome {
    return this.gateway.confirm(this.ownerCredential, invocationId, approve);
  }

  /**
   * The vault assistant's WRITE tool (issue #286 phase 2): typed commands
   * riding an enrolled `_assistant` agent — NOT the owner-device
   * credential, deliberately: agents carry a structural `medium` risk
   * ceiling, so high-risk commands park for the owner's explicit say-so
   * in the existing approval surface. Reads bypass the keyhole (sql);
   * writes keep the contract + parking asymmetry.
   *
   * The standing act grant is minted idempotently on first use: the
   * assistant is the owner's own hands, so using it IS the consent —
   * scoped to `act` (never widens reads, which don't ride grants here).
   */
  invokeAsAssistant(request: InvokeRequest): InvokeOutcome {
    const agent = ensureAgentEnrolled(this.db, '_assistant', { modelRef: 'centraid-assistant' });
    // Self-healing standing grant: cover every command owner_schema not
    // already scoped by an active grant — a later-installed app's ext band
    // (a NEW schema namespace) joins the assistant's write surface without
    // any re-enrollment ceremony.
    const schemas = this.db.vault
      .prepare(`SELECT DISTINCT owner_schema FROM agent_command ORDER BY owner_schema`)
      .all() as { owner_schema: string }[];
    const covered = new Set(
      (
        this.db.vault
          .prepare(
            `SELECT DISTINCT s.schema_name FROM consent_grant_scope s
               JOIN consent_access_grant g ON g.grant_id = s.grant_id
              WHERE g.grantee_party_id = ? AND g.status = 'active' AND g.revoked_at IS NULL`,
          )
          .all(agent.partyId) as { schema_name: string }[]
      ).map((r) => r.schema_name),
    );
    const missing = schemas.filter((s) => !covered.has(s.owner_schema));
    if (missing.length > 0) {
      const purpose = purposeConceptId(this.db, 'dpv:ServiceProvision');
      if (!purpose) throw new Error('vault vocabulary missing dpv:ServiceProvision');
      createGrant(this.db, {
        granteePartyId: agent.partyId,
        purposeConceptId: purpose,
        grantedByPartyId: this.boot.ownerPartyId,
        scopes: missing.map((s) => ({ schema: s.owner_schema, verbs: 'act' as const })),
      });
      this.logger.info(
        `vault plane: extended the _assistant standing act grant (+${missing.length} schema(s))`,
      );
    }
    const cred: Credential = {
      kind: 'agent',
      agentId: agent.agentId,
      deviceId: this.boot.deviceId,
      deviceKey: this.boot.deviceKey,
    };
    return this.gateway.invoke(cred, request);
  }

  /**
   * The vault assistant's read tool (owner register): one read-only SQL
   * statement over the whole canonical model, receipted. Rides the
   * owner-device credential — the assistant IS the owner asking their own
   * vault, so no grant keyhole applies (single-tenant by design).
   */
  sqlAsOwner(sql: string, maxRows?: number): VaultSqlResult {
    return this.gateway.sql(this.ownerCredential, {
      sql,
      ...(maxRows !== undefined ? { maxRows } : {}),
      purpose: 'owner-assistant',
    });
  }

  /** The assistant's schema + ontology map, built live from this vault. */
  assistantContext(): string {
    return buildAssistantContext(this.db);
  }

  /**
   * Resolve (type, id) refs to renderable cards as the owner — the
   * assistant UI turns answer citations (`@[…](ref:type/id)`) into entity
   * cards through this.
   */
  resolveAsOwner(refs: { type: string; id: string }[]): ResolveResult {
    return this.gateway.resolveRefs(this.ownerCredential, {
      refs,
      purpose: 'owner-assistant',
    });
  }

  sweep(): SweepResult {
    return this.gateway.sweep(this.ownerCredential);
  }

  /**
   * The ext band (issue #286 phase 2) — the host applies an app's DECLARED
   * extension tables (manifest `ext.tables`) to the live band; the vault
   * gateway diffs, validates and receipts. Idempotent: same specs → no-op.
   */
  applyAppExt(appId: string, tables: ExtTableSpec[]): ExtApplyOutcome {
    const outcome = this.gateway.applyAppExt(this.ownerCredential, appId, tables);
    if (outcome.created.length + outcome.dropped.length + outcome.altered.length > 0) {
      this.logger.info(
        `vault plane: ext band for "${appId}" — created [${outcome.created.join(', ')}] ` +
          `dropped [${outcome.dropped.join(', ')}] altered [${outcome.altered.join(', ')}]`,
      );
    }
    return outcome;
  }

  /** Rebuild the app's DRAFT band from specs, seeded with live rows. */
  seedAppExtDraft(appId: string, tables: ExtTableSpec[]): ExtApplyOutcome {
    return this.gateway.seedAppExtDraft(this.ownerCredential, appId, tables);
  }

  /** Discard the app's draft band (builder session close / reset). */
  dropAppExtDraft(appId: string): { dropped: string[] } {
    return this.gateway.dropAppExtDraft(this.ownerCredential, appId);
  }

  /** Owner purge of a retained band — the explicit second half of uninstall. */
  purgeAppExt(appId: string): { purged: string[] } {
    const out = this.gateway.purgeAppExt(this.ownerCredential, appId);
    if (out.purged.length > 0) {
      this.logger.info(`vault plane: purged ext band for "${appId}" [${out.purged.join(', ')}]`);
    }
    return out;
  }

  /**
   * The per-app `ctx.vault` executor. Credential resolution happens per
   * call so a revocation lands immediately — there is no cached identity
   * a stale worker could keep using.
   */
  bridgeFor(appId: string): VaultBridge {
    return async (call): Promise<VaultCallResult> => {
      const app = lookupAppByName(this.db, appId);
      if (!app) {
        return {
          ok: false,
          code: 'VAULT_NOT_ENROLLED',
          error: `app "${appId}" is not enrolled in the vault`,
        };
      }
      const cred: Credential = { kind: 'app', appId: app.appId, signingKey: app.signingKey };
      return asVaultCallResult(() => {
        switch (call.op) {
          case 'read':
            return this.gateway.read(cred, call.payload as unknown as ReadRequest);
          case 'search':
            return this.gateway.search(cred, call.payload as unknown as SearchRequest);
          case 'invoke':
            return this.gateway.invoke(cred, call.payload as unknown as InvokeRequest);
          case 'query':
            return this.gateway.queryView(
              cred,
              String(call.payload.view ?? ''),
              String(call.payload.purpose ?? ''),
              app.appId,
            );
          case 'describe':
            return this.gateway.discover(cred);
          case 'parked':
            // The app's own parked invocations — the "my pending approvals"
            // surface blueprints used to fake session-locally (issue #260).
            return this.gateway
              .listParked()
              .filter((p) => p.callerKind === 'app' && p.caller === appId);
          case 'resolve':
            // Cross-domain reference cards (issue #272) — resolvable when a
            // live core.link ties the ref to something this app reads.
            return this.gateway.resolveRefs(cred, call.payload as unknown as RefRequest);
          case 'changes':
            throw new GatewayError(
              'consent',
              'the provenance feed is agent-plane — automations ride vault changes, apps do not',
            );
          default:
            throw new Error(`unsupported vault op ${call.op}`);
        }
      });
    };
  }

  /**
   * The per-automation `ctx.vault` executor — the agent-plane mirror of
   * `bridgeFor`. Fires authenticate as the automation's enrolled
   * `agent.agent` riding the host's owner device (session binding, §12);
   * risk ceiling is structurally `medium`, so `high` commands park for
   * owner confirmation. Credential resolution happens per call so a
   * revocation lands immediately.
   */
  agentBridgeFor(appId: string): VaultBridge {
    return async (call): Promise<VaultCallResult> => {
      const agent = lookupAgentByName(this.db, appId);
      if (!agent) {
        return {
          ok: false,
          code: 'VAULT_NOT_ENROLLED',
          error: `automation "${appId}" has no enrolled vault agent`,
        };
      }
      const cred: Credential = {
        kind: 'agent',
        agentId: agent.agentId,
        deviceId: this.boot.deviceId,
        deviceKey: this.boot.deviceKey,
      };
      return asVaultCallResult(() => {
        switch (call.op) {
          case 'read':
            return this.gateway.read(cred, call.payload as unknown as ReadRequest);
          case 'search':
            return this.gateway.search(cred, call.payload as unknown as SearchRequest);
          case 'invoke':
            return this.gateway.invoke(cred, call.payload as unknown as InvokeRequest);
          case 'describe':
            return this.gateway.discover(cred);
          case 'parked':
            // This agent's own invocations awaiting the owner — the handler
            // sees WHAT is pending, never another caller's business.
            return this.gateway
              .listParked()
              .filter((p) => p.callerKind === 'agent' && p.caller === appId);
          case 'resolve':
            return this.gateway.resolveRefs(cred, call.payload as unknown as RefRequest);
          case 'changes':
            // The consented provenance feed data triggers ride; also callable
            // from handlers that want to catch up since a stored cursor.
            return this.gateway.changes(cred, call.payload as unknown as ChangesRequest);
          case 'query':
            throw new GatewayError(
              'consent',
              'registered views belong to apps — automations read entities directly',
            );
          default:
            throw new Error(`unsupported vault op ${call.op}`);
        }
      });
    };
  }

  /** Begin the standing-duty clock: a sweep now, then one per interval. */
  start(): void {
    this.runSweep();
    this.sweepTimer = setInterval(() => this.runSweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  private runSweep(): void {
    try {
      const result = this.sweep();
      const touched =
        result.grantsExpired +
        result.sharesExpired +
        result.contentPurged +
        result.retentionDeleted;
      if (touched > 0) {
        this.logger.info(
          `vault plane: sweep grantsExpired=${result.grantsExpired} sharesExpired=${result.sharesExpired} ` +
            `contentPurged=${result.contentPurged} retentionDeleted=${result.retentionDeleted}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `vault plane: sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Stop the clock, checkpoint the WALs, close the files. Idempotent. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    try {
      this.gateway.checkpoint(this.ownerCredential);
    } catch (err) {
      this.logger.warn(
        `vault plane: checkpoint on stop failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (this.transcriptsDb) {
      try {
        this.transcriptsDb.close();
      } catch {
        /* already closed */
      }
      this.transcriptsDb = undefined;
    }
    this.db.close();
  }
}

export function openVaultPlane(options: VaultPlaneOptions): VaultPlane {
  return new VaultPlane(options);
}
