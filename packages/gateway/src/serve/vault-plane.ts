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
  clearAllScopeTombstones,
  clearScopeTombstones,
  closeObsoleteScopeRequest,
  getOpenScopeRequest,
  hasGrantHistory,
  listOpenScopeRequests,
  listScopeTombstones,
  markScopeRequestDecided,
  openScopeRequest,
  writeScopeTombstones,
  type ScopeRequestSummary,
  type ScopeTriple,
  renameVault,
  readVaultPresentation,
  updateVaultPresentation,
  type VaultPresentation,
  registerAttachmentCommands,
  registerBusinessCommands,
  registerDocumentCommands,
  registerEnrichCommands,
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
  registerOutboxCommands,
  registerJudgmentCommands,
  registerSyncCommands,
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
  type RevealRequest,
  type RevocationResult,
  type ScopeSpec,
  type SearchRequest,
  type SweepResult,
  type VaultDb,
  type VaultSqlResult,
  type ResolveResult,
  type ExtApplyOutcome,
  type ExtTableSpec,
  type DemoPurgeResult,
} from '@centraid/vault';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  ensureConversationLedger,
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

/** A manifest's declared vault block, as install-time consent (issue #306). */
export interface InstallScopeBlock {
  purpose?: string;
  scopes: readonly { schema: string; table?: string; verbs: ScopeSpec['verbs'] }[];
}

/** One outbox item as the owner surface lists it (issue #306). */
export interface OutboxItemSummary {
  itemId: string;
  connection: { kind: string; label: string };
  actor: string | null;
  actorKind: string;
  verb: string;
  target: string;
  artifact: Record<string, unknown>;
  status: string;
  grantId: string | null;
  stagedAt: string;
  decidedAt: string | null;
  drainedAt: string | null;
  result: Record<string, unknown> | null;
  note: string | null;
}

/** One review-feed entry: a receipt ranked by risk salience (issue #306). */
export interface ReviewEntry {
  receiptId: string;
  action: string;
  objectType: string;
  objectId: string | null;
  decision: string;
  occurredAt: string;
  /** Salience marker off the receipt detail — absent on pre-#306 receipts. */
  risk: string | null;
  invocationId: string | null;
  /** Acting identity row id (agent/app/device) when an invocation exists. */
  actorId: string | null;
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

/**
 * Declared scopes not yet covered by any active grant — exact-triple diff.
 * Tombstoned triples (issue #308 A4) are the owner's standing "no": they are
 * neither re-granted nor re-requested, only an explicit owner approval
 * (which clears the tombstone) brings one back.
 */
function missingScopes(
  grants: GrantSummary[],
  declared: InstallScopeBlock['scopes'],
  tombstoned: readonly ScopeTriple[] = [],
): ScopeSpec[] {
  const key = (s: { schema: string; table?: string | null; verbs: string }): string =>
    `${s.schema}|${s.table ?? ''}|${s.verbs}`;
  const covered = new Set(grants.flatMap((g) => g.scopes.map(key)));
  for (const t of tombstoned) covered.add(key(t));
  return declared
    .filter((s) => !covered.has(key(s)))
    .map((s) => ({
      schema: s.schema,
      ...(s.table !== undefined ? { table: s.table } : {}),
      verbs: s.verbs,
    }));
}

/** The `content` op's request shape (issue #299): one derivative fetch. */
interface AgentContentRequest {
  contentId: string;
  variant: string;
  maxBytes?: number;
  purpose?: string;
}

/** The async twin — the `content` op awaits custody I/O (issue #299). */
async function asVaultCallResultAsync(fn: () => Promise<unknown>): Promise<VaultCallResult> {
  try {
    return { ok: true, result: await fn() };
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
  /**
   * Whether the journal's conversation-ledger band has been ensured on this
   * plane's handle. The workspace serves the SAME `journal.db` connection the
   * audit stream uses (the old standalone `transcripts.db` folded in) — the
   * ledger DDL is idempotent and never touches the audit ladder's
   * user_version, so ensuring lazily on first workspace use is safe.
   */
  private ledgerReady = false;

  constructor(options: VaultPlaneOptions) {
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 60 * 1000;
    this.dir = options.dir;
    // S3 blob-store credentials are HARNESS-AMBIENT (issue #296 §2, the
    // #290 broker posture): they live in the gateway process environment,
    // never in settings or vault rows. A vault whose settings name an s3
    // tier without the env pair stays local-only and the replication sweep
    // reports the gap instead of failing writes.
    this.db = openVaultDb({
      dir: options.dir,
      s3Credentials: () => {
        const accessKeyId = process.env.CENTRAID_S3_ACCESS_KEY_ID;
        const secretAccessKey = process.env.CENTRAID_S3_SECRET_ACCESS_KEY;
        if (!accessKeyId || !secretAccessKey) {
          return Promise.reject(
            new Error(
              's3 blob store configured but CENTRAID_S3_ACCESS_KEY_ID / CENTRAID_S3_SECRET_ACCESS_KEY are not in the gateway environment (issue #296: creds are harness-ambient, never settings)',
            ),
          );
        }
        const sessionToken = process.env.CENTRAID_S3_SESSION_TOKEN;
        return Promise.resolve({
          accessKeyId,
          secretAccessKey,
          ...(sessionToken ? { sessionToken } : {}),
        });
      },
    });
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
    registerSyncCommands(this.gateway);
    registerEnrichCommands(this.gateway);
    registerOutboxCommands(this.gateway);
    registerJudgmentCommands(this.gateway);
    // Re-arm the ext-band write trios for every installed app that
    // declared extension tables (issue #286 phase 2) — command handlers
    // live in gateway memory, the contract rows in the vault.
    this.gateway.registerAllExtCommands();
    this.logger.info(
      this.boot.fresh
        ? `vault plane: bootstrapped a fresh vault at ${options.dir}`
        : `vault plane: recovered vault ${this.boot.vaultId} at ${options.dir}`,
    );
    if (existsSync(path.join(options.dir, 'transcripts.db'))) {
      // Pre-fold layout (v0: no data migrations) — the conversation ledger
      // now lives in journal.db; the old file stays put but is never read.
      this.logger.warn(
        `vault plane: ignoring legacy transcripts.db at ${options.dir} — ` +
          'the conversation ledger folded into journal.db',
      );
    }
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
      journal: () => this.journalLedger(),
      journalDbFile: path.join(this.dir, 'journal.db'),
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

  /** This vault's `journal.db` handle with the ledger band ensured. */
  private journalLedger(): DatabaseSync {
    if (this.closed) throw new Error(`vault plane ${this.boot.vaultId} is stopped`);
    if (!this.ledgerReady) {
      ensureConversationLedger(this.db.journal);
      this.ledgerReady = true;
    }
    return this.db.journal;
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
    // Standing outbox grants die with the actor (issue #306): an
    // uninstalled app's "always allow" rules must not outlive it.
    for (const actorId of [app?.appId, agent?.agentId]) {
      if (!actorId) continue;
      const rules = this.db.vault
        .prepare('SELECT grant_id FROM outbox_grant WHERE actor_id = ? AND revoked_at IS NULL')
        .all(actorId) as { grant_id: string }[];
      for (const rule of rules) {
        this.revokeOutboxGrant(rule.grant_id);
        this.logger.info(
          `vault plane: revoked standing outbox grant ${rule.grant_id} for "${appId}"`,
        );
      }
    }
    // Uninstall wipes the consent memory (issue #308 A3/A4): the cascade's
    // own revocations just tombstoned every scope, but uninstall is "no to
    // the whole app", not "no to these scopes forever" — a reinstall is a
    // fresh install-time consent. Open widening requests go with it.
    if (app) clearAllScopeTombstones(this.db, { appId: app.appId });
    if (agent) clearAllScopeTombstones(this.db, { granteePartyId: agent.partyId });
    closeObsoleteScopeRequest(this.db, 'app', appId);
    closeObsoleteScopeRequest(this.db, 'agent', appId);
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
    // An explicit owner approval overrides a past revocation (issue #308 A4).
    clearScopeTombstones(this.db, { appId: app.appId }, request.scopes);
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
    // An explicit owner approval overrides a past revocation (issue #308 A4).
    clearScopeTombstones(this.db, { granteePartyId: agent.partyId }, request.scopes);
    return createGrant(this.db, {
      granteePartyId: agent.partyId,
      purposeConceptId: purpose,
      grantedByPartyId: this.boot.ownerPartyId,
      scopes: request.scopes,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    });
  }

  /**
   * Install-time scopes (issue #306 decision 2, bounded by issue #308 A3/A4):
   * installing the app WAS the consent — for the scopes declared AT install.
   * The first grant (no consent history) covers the whole declared block;
   * after that the top-up never widens on its own: a manifest declaring
   * scopes beyond the last owner consent parks a `consent_scope_request`
   * blocking item (agents author their own manifests — auto-granting a
   * re-publish would let the contained actor steer its own containment),
   * and owner-revoked scopes are tombstoned — neither re-granted nor
   * re-requested until the owner explicitly approves them again.
   */
  ensureAppInstallGrant(appId: string, block: InstallScopeBlock): void {
    const app = ensureAppEnrolled(this.db, appId, { origin: 'generated' });
    this.ensureInstallGrant({
      plane: 'app',
      appId,
      block,
      grantee: { appId: app.appId },
      grants: listActiveGrants(this.db, app.appId),
      approve: (request) => void this.approveGrant(appId, request),
    });
  }

  /** The agent-plane mirror: an automation's declared scopes, granted at install. */
  ensureAgentInstallGrant(appId: string, block: InstallScopeBlock): void {
    const agent = ensureAgentEnrolled(this.db, appId, { modelRef: 'centraid-automation' });
    this.ensureInstallGrant({
      plane: 'agent',
      appId,
      block,
      grantee: { granteePartyId: agent.partyId },
      grants: listActiveAgentGrants(this.db, agent.partyId),
      approve: (request) => void this.approveAgentGrant(appId, request),
    });
  }

  private ensureInstallGrant(input: {
    plane: 'app' | 'agent';
    appId: string;
    block: InstallScopeBlock;
    grantee: { appId?: string; granteePartyId?: string };
    grants: GrantSummary[];
    approve: (request: GrantRequest) => void;
  }): void {
    const purpose = input.block.purpose ?? 'dpv:ServiceProvision';
    const tombstoned = listScopeTombstones(this.db, input.grantee);
    const missing = missingScopes(input.grants, input.block.scopes, tombstoned);
    if (missing.length === 0) {
      // Nothing is being asked anymore (the manifest narrowed, the owner
      // decided, or everything asked-for is tombstoned) — a stale open
      // request must not keep blocking the owner.
      closeObsoleteScopeRequest(this.db, input.plane, input.appId);
      return;
    }
    if (!hasGrantHistory(this.db, input.grantee)) {
      // First consent: installing was the consent for the declared block.
      input.approve({ purpose, scopes: missing });
      this.logger.info(
        `vault plane: install-time grant for ${input.plane} "${input.appId}" (+${missing.length} scope(s))`,
      );
      return;
    }
    // Widened beyond the last owner consent (issue #308 A3): park the ask.
    openScopeRequest(this.db, {
      plane: input.plane,
      appId: input.appId,
      purpose,
      scopes: missing.map((s) => ({
        schema: s.schema,
        ...(s.table !== undefined ? { table: s.table } : {}),
        verbs: s.verbs,
      })),
    });
    this.logger.info(
      `vault plane: ${input.plane} "${input.appId}" asks for ${missing.length} scope(s) beyond its last consent — parked for the owner`,
    );
  }

  /** Open scope-widening requests — blocking items (issue #308 A3). */
  listScopeRequests(): ScopeRequestSummary[] {
    return listOpenScopeRequests(this.db);
  }

  /**
   * The owner's decision on a widening request. Approve mints the grant
   * (clearing any tombstones on those triples — an explicit yes overrides a
   * past no); deny tombstones the asked triples so the same manifest does
   * not re-ask on every mount.
   */
  decideScopeRequest(requestId: string, approve: boolean): ScopeRequestSummary {
    const request = getOpenScopeRequest(this.db, requestId);
    if (!request) throw new Error(`no open scope request ${requestId}`);
    const grantee = this.granteeFor(request);
    if (approve) {
      clearScopeTombstones(this.db, grantee, request.scopes);
      const grantRequest: GrantRequest = {
        purpose: request.purpose,
        scopes: request.scopes.map((s) => ({
          schema: s.schema,
          ...(s.table !== undefined ? { table: s.table } : {}),
          verbs: s.verbs,
        })),
      };
      if (request.plane === 'app') this.approveGrant(request.appId, grantRequest);
      else this.approveAgentGrant(request.appId, grantRequest);
    } else {
      writeScopeTombstones(this.db, grantee, request.scopes);
    }
    markScopeRequestDecided(this.db, requestId, approve ? 'approved' : 'denied');
    this.logger.info(
      `vault plane: owner ${approve ? 'approved' : 'denied'} the ${request.plane} "${request.appId}" scope request (${request.scopes.length} scope(s))`,
    );
    return request;
  }

  /** Resolve a request's grantee key on its identity plane. */
  private granteeFor(request: ScopeRequestSummary): {
    appId?: string;
    granteePartyId?: string;
  } {
    if (request.plane === 'app') {
      const app = ensureAppEnrolled(this.db, request.appId, { origin: 'generated' });
      return { appId: app.appId };
    }
    const agent = ensureAgentEnrolled(this.db, request.appId, {
      modelRef: 'centraid-automation',
    });
    return { granteePartyId: agent.partyId };
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
   * The outbox surface (issue #306): items as the owner reads them — the
   * artifact itself, WHO staged it, and where it would go. Host-plane
   * queries like `listParked`; the request_json stays server-side (it is
   * the executor's business, and it may carry placeholder plumbing the
   * owner shouldn't have to parse).
   */
  listOutbox(statuses?: readonly string[]): OutboxItemSummary[] {
    const filter = statuses && statuses.length > 0 ? statuses : null;
    const rows = this.db.vault
      .prepare(
        `SELECT i.item_id, i.actor_id, i.actor_kind, i.verb, i.target, i.artifact_json,
                i.status, i.grant_id, i.staged_at, i.decided_at, i.drained_at, i.result_json,
                i.note, c.kind, c.label
           FROM outbox_item i JOIN sync_connection c ON c.connection_id = i.connection_id
          ${filter ? `WHERE i.status IN (${filter.map(() => '?').join(', ')})` : ''}
          ORDER BY i.staged_at DESC LIMIT 500`,
      )
      .all(...(filter ?? [])) as {
      item_id: string;
      actor_id: string;
      actor_kind: string;
      verb: string;
      target: string;
      artifact_json: string;
      status: string;
      grant_id: string | null;
      staged_at: string;
      decided_at: string | null;
      drained_at: string | null;
      result_json: string | null;
      note: string | null;
      kind: string;
      label: string;
    }[];
    return rows.map((r) => ({
      itemId: r.item_id,
      connection: { kind: r.kind, label: r.label },
      actor: this.actorName(r.actor_id, r.actor_kind),
      actorKind: r.actor_kind,
      verb: r.verb,
      target: r.target,
      artifact: JSON.parse(r.artifact_json) as Record<string, unknown>,
      status: r.status,
      grantId: r.grant_id,
      stagedAt: r.staged_at,
      decidedAt: r.decided_at,
      drainedAt: r.drained_at,
      result: r.result_json ? (JSON.parse(r.result_json) as Record<string, unknown>) : null,
      note: r.note,
    }));
  }

  /** Owner decision on one outbox item — rides the typed command, receipted. */
  decideOutbox(input: {
    itemId: string;
    decision: 'approve' | 'discard';
    artifact?: Record<string, unknown>;
    request?: Record<string, unknown>;
    alwaysAllow?: boolean;
    note?: string;
  }): InvokeOutcome {
    return this.gateway.invoke(this.ownerCredential, {
      command: 'outbox.decide',
      input: {
        item_id: input.itemId,
        decision: input.decision,
        ...(input.artifact ? { artifact: input.artifact } : {}),
        ...(input.request ? { request: input.request } : {}),
        ...(input.alwaysAllow !== undefined ? { always_allow: input.alwaysAllow } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
    });
  }

  /** Standing (actor, verb, target) rules, live first (issue #306 phase 3). */
  listOutboxGrants(): Array<{
    grantId: string;
    actor: string | null;
    actorId: string;
    verb: string;
    target: string;
    createdAt: string;
    revokedAt: string | null;
  }> {
    const rows = this.db.vault
      .prepare(
        `SELECT grant_id, actor_id, verb, target, created_at, revoked_at
           FROM outbox_grant ORDER BY revoked_at IS NOT NULL, created_at DESC`,
      )
      .all() as {
      grant_id: string;
      actor_id: string;
      verb: string;
      target: string;
      created_at: string;
      revoked_at: string | null;
    }[];
    return rows.map((r) => ({
      grantId: r.grant_id,
      actor: this.actorName(r.actor_id, 'ai_agent') ?? this.actorName(r.actor_id, 'app'),
      actorId: r.actor_id,
      verb: r.verb,
      target: r.target,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    }));
  }

  revokeOutboxGrant(grantId: string): InvokeOutcome {
    return this.gateway.invoke(this.ownerCredential, {
      command: 'outbox.revoke_grant',
      input: { grant_id: grantId },
    });
  }

  /**
   * The BLOCKING list (issue #306 decision 5): only things actually waiting
   * on the owner — pending outbox artifacts, needs-auth connections, and
   * Tier 3/4 parked confirmations. Everything else belongs to the review
   * feed, not here.
   */
  blocking(): {
    outbox: OutboxItemSummary[];
    needsAuth: Array<{ connectionId: string; kind: string; label: string; note: string | null }>;
    parked: ParkedSummary[];
    /** Manifest scope-widening asks awaiting the owner (issue #308 A3). */
    scopeRequests: ScopeRequestSummary[];
  } {
    const needsAuth = this.db.vault
      .prepare(
        `SELECT c.connection_id, c.kind, c.label, h.auth_note
           FROM sync_connection c
           LEFT JOIN sync_connection_health h ON h.connection_id = c.connection_id
          WHERE c.status = 'needs-auth' ORDER BY c.kind, c.label`,
      )
      .all() as { connection_id: string; kind: string; label: string; auth_note: string | null }[];
    return {
      outbox: this.listOutbox(['pending']),
      needsAuth: needsAuth.map((r) => ({
        connectionId: r.connection_id,
        kind: r.kind,
        label: r.label,
        note: r.auth_note,
      })),
      parked: this.listParked(),
      scopeRequests: this.listScopeRequests(),
    };
  }

  /**
   * The review feed (issue #306 decision 5): what HAPPENED, salience-ranked —
   * risk-marker-weighted receipts over a recent window, denies surfacing
   * above allows of the same tier. Review-after-the-fact is the Tier 1
   * consent mechanism; this is its surface.
   */
  reviewFeed(limit = 50): ReviewEntry[] {
    const window = this.db.journal
      .prepare(
        `SELECT r.receipt_id, r.action, r.object_type, r.object_id, r.decision, r.occurred_at,
                r.detail_json, r.invocation_id, i.agent_id
           FROM consent_receipt r
           LEFT JOIN agent_command_invocation i ON i.invocation_id = r.invocation_id
          WHERE r.action LIKE 'act %'
          ORDER BY r.receipt_id DESC LIMIT 500`,
      )
      .all() as {
      receipt_id: string;
      action: string;
      object_type: string;
      object_id: string | null;
      decision: string;
      occurred_at: string;
      detail_json: string | null;
      invocation_id: string | null;
      agent_id: string | null;
    }[];
    const riskRank: Record<string, number> = { high: 2, medium: 1, low: 0 };
    const entries = window.map((r) => {
      let risk: string | null = null;
      if (r.detail_json) {
        const detail = JSON.parse(r.detail_json) as { risk?: unknown };
        if (typeof detail.risk === 'string') risk = detail.risk;
      }
      return {
        entry: {
          receiptId: r.receipt_id,
          action: r.action,
          objectType: r.object_type,
          objectId: r.object_id,
          decision: r.decision,
          occurredAt: r.occurred_at,
          risk,
          invocationId: r.invocation_id,
          actorId: r.agent_id,
        } satisfies ReviewEntry,
        salience: (riskRank[risk ?? ''] ?? 0) + (r.decision === 'deny' ? 1 : 0),
      };
    });
    return entries
      .sort(
        (a, b) => b.salience - a.salience || b.entry.occurredAt.localeCompare(a.entry.occurredAt),
      )
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map((e) => e.entry);
  }

  /**
   * The install/consent surface for one app (issue #306 phase 4): every
   * scope its identities hold (app plane + automation agent plane), plus
   * salience highlights — the act commands those scopes reach, risk-ranked,
   * confirm-gated (Tier 3/4) verbs flagged. "This app can delete notes" is
   * a render of this, not a judgment call.
   */
  scopeSurface(appId: string): {
    scopes: Array<{
      plane: 'app' | 'agent';
      schema: string;
      table: string | null;
      verbs: string;
    }>;
    highlights: Array<{ command: string; schema: string; risk: string; confirm: boolean }>;
  } {
    const scopes: Array<{
      plane: 'app' | 'agent';
      schema: string;
      table: string | null;
      verbs: string;
    }> = [];
    const app = lookupAppByName(this.db, appId);
    if (app) {
      for (const grant of listActiveGrants(this.db, app.appId)) {
        for (const s of grant.scopes) {
          scopes.push({ plane: 'app', schema: s.schema, table: s.table, verbs: s.verbs });
        }
      }
    }
    const agent = lookupAgentByName(this.db, appId);
    if (agent) {
      for (const grant of listActiveAgentGrants(this.db, agent.partyId)) {
        for (const s of grant.scopes) {
          scopes.push({ plane: 'agent', schema: s.schema, table: s.table, verbs: s.verbs });
        }
      }
    }
    const actSchemas = [
      ...new Set(scopes.filter((s) => s.verbs.includes('act')).map((s) => s.schema)),
    ];
    const highlights =
      actSchemas.length === 0
        ? []
        : (
            this.db.vault
              .prepare(
                `SELECT c.name, c.owner_schema, c.risk, cap.requires_confirmation
                 FROM agent_command c
                 JOIN agent_capability cap ON cap.command_id = c.command_id
                WHERE c.owner_schema IN (${actSchemas.map(() => '?').join(', ')})
                ORDER BY CASE c.risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, c.name`,
              )
              .all(...actSchemas) as {
              name: string;
              owner_schema: string;
              risk: string;
              requires_confirmation: number;
            }[]
          ).map((r) => ({
            command: r.name,
            schema: r.owner_schema,
            risk: r.risk,
            confirm: r.requires_confirmation === 1,
          }));
    return { scopes, highlights };
  }

  /** Display name for an outbox actor row id (agent party / app name). */
  private actorName(actorId: string, actorKind: string): string | null {
    if (actorKind === 'owner') return 'owner';
    const row = this.db.vault
      .prepare(
        actorKind === 'app'
          ? 'SELECT name FROM consent_app WHERE app_id = ?'
          : `SELECT p.display_name AS name FROM agent_agent a
               JOIN core_party p ON p.party_id = a.party_id WHERE a.agent_id = ?`,
      )
      .get(actorId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /**
   * The vault assistant's WRITE tool (issue #286 phase 2): typed commands
   * riding an enrolled `_assistant` agent — NOT the owner-device
   * credential, deliberately: Tier 3/4 confirm-gated commands (issue #306)
   * park for the owner's explicit say-so in the existing approval surface.
   * Reads bypass the keyhole (sql); writes keep the contract + parking
   * asymmetry for the loud-on-purpose verbs.
   *
   * THE ASSISTANT'S AUTHORITY, WRITTEN DOWN (issue #308 B3): `_assistant`
   * holds a standing `act` grant over EVERY command schema — it is a more
   * privileged actor than any installed app, bypassing install-time scoping
   * entirely. This is intentional ("the assistant is the owner's hands"):
   * the containment is (1) confirm-gated commands park for it like any
   * non-owner — with the credential-touching set gated since #308 A1/A2 —
   * (2) it cannot decide/drain the outbox (owner-plane only), reveal sealed
   * plaintext, or read another actor's invocations, and (3) every act is
   * receipted under its own agent identity, so the review feed names it.
   *
   * The standing act grant is minted idempotently on first use: the
   * assistant is the owner's own hands, so using it IS the consent —
   * scoped to `act` (never widens reads, which don't ride grants here).
   * The owner CAN narrow it durably: a revoked assistant grant tombstones
   * its schemas (issue #308 A4), and the self-heal below skips tombstoned
   * schemas until the owner explicitly re-approves them.
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
    // The owner's "no" binds the assistant too (issue #308 A4/B3).
    for (const t of listScopeTombstones(this.db, { granteePartyId: agent.partyId })) {
      if (t.verbs === 'act') covered.add(t.schema);
    }
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

  /**
   * The assistant's document-text access (issue #299): the `text` variant
   * (extracted document text / inline body) of one content item, receipted.
   * Owner-credentialed like `sqlAsOwner` — the assistant IS the owner
   * reading their own document. Text-first by design; binary variants stay
   * on the enricher plane.
   */
  contentAsOwner(call: { contentId: string }): Promise<unknown> {
    return this.gateway.contentForAgent(this.ownerCredential, {
      contentId: call.contentId,
      variant: 'text',
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
   * The scenario-seed `ctx.vault` executor (issue #290 phase 1): a seed
   * generator is the OWNER loading demo data, so calls ride the owner-device
   * credential with the demo register set — every write stamps `seed.demo`
   * provenance and lands in the seed registry, purgeable in one act and
   * invisible to the automation plane. Reads let a generator reference what
   * it already minted; nothing else is exposed.
   */
  demoBridgeFor(appId: string): VaultBridge {
    return async (call): Promise<VaultCallResult> =>
      asVaultCallResult(() => {
        switch (call.op) {
          case 'read':
            return this.gateway.read(this.ownerCredential, call.payload as unknown as ReadRequest);
          case 'search':
            return this.gateway.search(
              this.ownerCredential,
              call.payload as unknown as SearchRequest,
            );
          case 'invoke':
            return this.gateway.invoke(this.ownerCredential, {
              ...(call.payload as unknown as InvokeRequest),
              demo: { appId },
            });
          case 'describe':
            return this.gateway.discover(this.ownerCredential);
          case 'query':
          case 'parked':
          case 'changes':
          case 'resolve':
          case 'reveal':
          case 'content':
            // The seed surface is read/search/invoke/describe only; every
            // other op is off-limits to a scenario generator. Listed
            // explicitly so the switch stays exhaustive over VaultOp.
            throw new GatewayError(
              'consent',
              `seed generators read and invoke — vault op ${call.op} is not part of the scenario surface`,
            );
          default:
            throw new Error(`unsupported vault op ${call.op}`);
        }
      });
  }

  /** Purge demo data — whole vault or one app's scenario (issue #290). */
  purgeDemo(appId?: string): DemoPurgeResult {
    return this.gateway.purgeDemo(this.ownerCredential, appId);
  }

  /** Seeded-row counts per app — the "demo data present" surface. */
  demoStatus(): { appId: string; rows: number }[] {
    return this.gateway.demoStatus(this.ownerCredential);
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
      if (call.op === 'content') {
        // Derivative fetch (issue #299) — async custody I/O, receipted read.
        return asVaultCallResultAsync(() =>
          this.gateway.contentForAgent(cred, call.payload as unknown as AgentContentRequest),
        );
      }
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
          case 'reveal':
            // Sealed-column plaintext (issue #293) — takes the app's
            // explicit `reveal` scope; every allow is receipted per item.
            return this.gateway.reveal(cred, call.payload as unknown as RevealRequest);
          case 'changes':
            throw new GatewayError(
              'consent',
              'the provenance feed is agent-plane — automations ride vault changes, apps do not',
            );
          case 'content':
            // Unreachable: the async custody path (asVaultCallResultAsync)
            // above returns first. Listed so the switch stays exhaustive.
            throw new Error('content op is handled on the async path above');
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
   * Tier 3/4 confirm-gated commands (issue #306) park for owner
   * confirmation. Credential resolution happens per call so a revocation
   * lands immediately.
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
      if (call.op === 'content') {
        // The enricher's byte primitive (issue #299 §2): thumb/preview/text
        // only — the gateway refuses originals structurally, and every
        // fetch is receipted as the multimodal-egress consent event.
        return asVaultCallResultAsync(() =>
          this.gateway.contentForAgent(cred, call.payload as unknown as AgentContentRequest),
        );
      }
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
          case 'reveal':
            // Connector secrets resolution (issue #293 decision 8): the
            // agent's reveal grant names its specific items via row filter.
            return this.gateway.reveal(cred, call.payload as unknown as RevealRequest);
          case 'changes':
            // The consented provenance feed data triggers ride; also callable
            // from handlers that want to catch up since a stored cursor.
            return this.gateway.changes(cred, call.payload as unknown as ChangesRequest);
          case 'query':
            throw new GatewayError(
              'consent',
              'registered views belong to apps — automations read entities directly',
            );
          case 'content':
            // Unreachable: the async custody path (asVaultCallResultAsync)
            // above returns first. Listed so the switch stays exhaustive.
            throw new Error('content op is handled on the async path above');
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
        result.notesPurged +
        result.retentionDeleted +
        result.blobsReclaimed +
        result.stagingExpired;
      if (touched > 0) {
        this.logger.info(
          `vault plane: sweep grantsExpired=${result.grantsExpired} sharesExpired=${result.sharesExpired} ` +
            `contentPurged=${result.contentPurged} notesPurged=${result.notesPurged} ` +
            `retentionDeleted=${result.retentionDeleted} ` +
            `blobsReclaimed=${result.blobsReclaimed} stagingExpired=${result.stagingExpired}`,
        );
      }
      // Blob custody maintenance (issue #296): replicate to the remote tier
      // and reconcile orphans, detached — remote latency never blocks the
      // lifecycle sweep, and a vault with no remote tier no-ops.
      void this.gateway
        .sweepBlobs(this.ownerCredential)
        .then((blobs) => {
          if (blobs.replicated.length + blobs.orphansDeleted.length + blobs.missing.length > 0) {
            this.logger.info(
              `vault plane: blob sweep replicated=${blobs.replicated.length} orphansDeleted=${blobs.orphansDeleted.length} missing=${blobs.missing.length}`,
            );
          }
        })
        .catch((err: unknown) => {
          this.logger.warn(
            `vault plane: blob sweep failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
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
    this.db.close();
  }
}

export function openVaultPlane(options: VaultPlaneOptions): VaultPlane {
  return new VaultPlane(options);
}
