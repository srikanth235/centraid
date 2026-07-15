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
  registerTagCommands,
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
  type BlobStoreSettings,
  type S3Credentials,
  type PreviewCodec,
  runJournalArchival,
  WalShipper,
  type WalShipperOptions,
} from '@centraid/vault';
import { existsSync, statSync } from 'node:fs';
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
import { applyRestoreQuarantine, type QuarantineStatus } from './vault-quarantine.js';

/** Blob-sweep failure backoff (issue #367 §C5) — one step per consecutive failure, flat-capped. */
const BLOB_SWEEP_BACKOFF_STEP_MS = 60_000;
const BLOB_SWEEP_MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Pure backoff decision (issue #367 §C5), extracted out of `runSweep` so it
 * is unit-testable without a live timer: no failures yet, or the backoff
 * window (since the last ATTEMPT, not the last success) has elapsed →
 * proceed; otherwise skip this tick. Exported for `vault-plane.test.ts`.
 */
export function blobSweepBackoff(
  status: { consecutiveFailures: number; lastAttemptedAt: string | null },
  nowMs: number,
): { skip: boolean; retryInMs: number } {
  if (status.consecutiveFailures <= 0 || !status.lastAttemptedAt)
    return { skip: false, retryInMs: 0 };
  const backoffMs = Math.min(
    BLOB_SWEEP_BACKOFF_STEP_MS * status.consecutiveFailures,
    BLOB_SWEEP_MAX_BACKOFF_MS,
  );
  const dueAtMs = Date.parse(status.lastAttemptedAt) + backoffMs;
  const retryInMs = dueAtMs - nowMs;
  return retryInMs > 0 ? { skip: true, retryInMs } : { skip: false, retryInMs: 0 };
}

/** The pre-#367 default: `CENTRAID_S3_*` in the gateway process environment. */
function defaultEnvS3Credentials(): Promise<S3Credentials> {
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
}

export interface VaultPlaneOptions {
  /** Directory holding `vault.db` + `journal.db`. Created if absent. */
  dir: string;
  /**
   * Per-vault DISPOSABLE cache dir, OUTSIDE the vault tree — home for the chat
   * runner scratch (`runner-sessions/`: the embedded runner's per-conversation
   * resume files + `assistant-cwd`). journal.db is the authoritative
   * conversation ledger; this is derived cache, so it lives beside the vault,
   * not inside it (safe to wipe, never backed up with the sovereign pair).
   * Defaults to the vault dir itself when omitted (tests / legacy callers).
   */
  cacheDir?: string;
  logger: RuntimeLogger;
  /** Owner display name used only on first boot. */
  ownerName?: string;
  /** Pre-minted vault id used only on first boot (multi-vault hosts name the dir after it). */
  vaultId?: string;
  /** Owner-facing vault name used only on first boot. */
  vaultName?: string;
  /** Sweep cadence for lifecycle duties. Default: hourly. */
  sweepIntervalMs?: number;
  /** WAL shipper capture cadence (issue #408). Default: 60 s. */
  walTickMs?: number;
  /** Disable WAL ownership for short-lived admin/read-only registry opens. */
  enableWalShipper?: boolean;
  /** WAL shipper overrides (tests: thresholds, clock). */
  walShipper?: Partial<Omit<WalShipperOptions, 'db' | 'log'>>;
  /**
   * Whether the gateway instance lease (issue #351 tier 1) is CURRENTLY
   * conflicted — a fresh foreign lease means a second gateway process may
   * legitimately be live against this same vault root. Read fresh on every
   * blob sweep tick (issue #367 §C6) to gate the orphan-delete phase of
   * `BlobCustody.reconcile()` — deleting a remote object this process
   * doesn't recognize would be a real data-loss risk if the OTHER instance
   * just wrote it. Defaults to "never conflicted" (single-instance hosts,
   * tests).
   */
  leaseConflicted?: () => boolean;
  /**
   * Resolve S3 credentials for a vault's remote blob tier (issue #367 §C3):
   * the gateway-level `StorageConnectionStore` wires this to
   * `settings.connectionId` (sealed byo-s3 creds, or a cached
   * `requestCasGrant` for a provider connection). Defaults to the legacy
   * harness-ambient env-var lane (`CENTRAID_S3_*`, issue #296 §2) for hosts
   * that haven't adopted storage connections yet.
   */
  s3Credentials?: (settings: BlobStoreSettings) => Promise<S3Credentials>;
  /**
   * The preview ladder's raster codec (issue #405 §2) — the host's pure-JS
   * jpeg-js/pngjs downscaler (`createImagePreviewCodec`), forwarded into
   * `openVaultDb` so this plane's blob sweep runs the preview backstop.
   * Omitted for hosts/tests without one: the backstop simply doesn't run.
   */
  previewCodec?: PreviewCodec;
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
  actorId: string;
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

/** Journal archival cadence (issue #367 §E2): once a day is plenty. */
const JOURNAL_ARCHIVAL_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class VaultPlane {
  readonly db: VaultDb;
  readonly gateway: VaultGateway;
  readonly boot: HostBootstrap;
  /** The vault's directory — the registry deletes it on vault removal. */
  readonly dir: string;
  /** Per-vault disposable cache dir (runner scratch), outside the vault tree. */
  readonly cacheDir: string;
  /**
   * Set when this vault's directory carried a `RESTORE_QUARANTINE.json`
   * marker at mount (FORMAT.md restore rule 4) — `null` otherwise. See
   * `vault-quarantine.ts` for exactly what got handled automatically
   * (outbox parking) versus what still needs an operator (automations).
   */
  readonly quarantine: QuarantineStatus | null;
  /**
   * The WAL segment shipper (issue #408) — always constructed for a
   * file-backed vault, backup configured or not: with `wal_autocheckpoint`
   * off on every connection, its threshold rollovers are what keeps the two
   * WALs bounded. Capture runs on `walTimer` (60 s); the BackupService's
   * drain loop uploads (or, unconfigured, discards) what it captured.
   */
  readonly walShipper: WalShipper | undefined;
  private readonly logger: RuntimeLogger;
  private readonly sweepIntervalMs: number;
  private readonly walTickMs: number;
  private readonly leaseConflicted: () => boolean;
  /** Whether this process is allowed to capture or checkpoint these WALs. */
  private readonly ownsWalLifecycle: boolean;
  private sweepTimer: NodeJS.Timeout | undefined;
  private walTimer: NodeJS.Timeout | undefined;
  private firstWalTick: NodeJS.Immediate | undefined;
  private lastJournalArchivalAt = 0;
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
    this.leaseConflicted = options.leaseConflicted ?? (() => false);
    this.dir = options.dir;
    // Runner scratch lives in a disposable cache OUTSIDE the vault tree; fall
    // back to the vault dir only for callers that don't supply one (tests).
    this.cacheDir = options.cacheDir ?? options.dir;
    // S3 blob-store credentials (issue #296 §2, extended #367 §C3): the
    // default lane stays HARNESS-AMBIENT env vars, never settings — but a
    // host that has wired a `StorageConnectionStore` (build-gateway.ts)
    // injects `options.s3Credentials`, which resolves per `connectionId`
    // instead (sealed byo-s3 creds, or a cached provider grant). A vault
    // whose settings name an s3 tier without a resolvable credential stays
    // local-only and the replication sweep reports the gap instead of
    // failing writes.
    this.db = openVaultDb({
      dir: options.dir,
      s3Credentials: options.s3Credentials ?? defaultEnvS3Credentials,
      // Preview backstop codec (issue #405 §2) — forwarded only when the host
      // wired one; a codec-less open just never runs the backstop.
      ...(options.previewCodec ? { previewCodec: options.previewCodec } : {}),
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
    registerTagCommands(this.gateway);
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
    // FORMAT.md restore rule 4: a directory adopted from a backup restore
    // carries RESTORE_QUARANTINE.json — park the outbox now, loudly flag
    // the automations gap (see vault-quarantine.ts header for why that
    // part stays manual).
    this.quarantine = applyRestoreQuarantine(options.dir, this.db, this.logger);
    // WAL shipper (issue #408). A restored-and-adopted directory has no
    // wal-ship state, so its first tick mints a fresh generation — which is
    // exactly the restore-takeover stream break FORMAT.md rule 6 requires.
    this.walTickMs = options.walTickMs ?? 60_000;
    this.ownsWalLifecycle =
      options.enableWalShipper !== false && !(options.leaseConflicted?.() ?? false);
    try {
      if (!this.ownsWalLifecycle) {
        this.walShipper = undefined;
      } else {
        this.walShipper = new WalShipper({
          db: this.db,
          log: {
            info: (m) => this.logger.info(m),
            warn: (m) => this.logger.warn(m),
          },
          ...options.walShipper,
        });
      }
    } catch (err) {
      // In-memory vaults (tests) have no files to ship.
      this.walShipper = undefined;
      if (this.dir !== ':memory:') {
        this.logger.warn(
          `vault plane: wal shipper unavailable: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
   * The vault's workspace (#280 — the vault is the unit): the ledger and
   * per-app data dirs that live BESIDE the sovereign pair inside this vault's
   * directory. The runner scratch (`runner-sessions/`) is the exception — it
   * is disposable cache derived from journal.db, so it lives in `cacheDir`
   * OUTSIDE the vault tree. app-engine operates entirely through this view;
   * the registry hands out the active one.
   */
  get workspace(): VaultWorkspace {
    return {
      vaultId: this.boot.vaultId,
      ownerPartyId: this.boot.ownerPartyId,
      appsDir: path.join(this.dir, 'apps'),
      journal: () => this.journalLedger(),
      journalDbFile: path.join(this.dir, 'journal.db'),
      runnerSessionDir: path.join(this.cacheDir, 'runner-sessions'),
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
  enrollAutomationAgent(appId: string, displayName?: string): void {
    const enrolled = ensureAgentEnrolled(this.db, appId, {
      modelRef: 'centraid-automation',
      ...(displayName ? { displayName } : {}),
    });
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
   *
   * `displayName`, when supplied, is the automation's real manifest name
   * (same value `reconcileScheduler` threads through `enrollAutomationAgent`
   * — build-gateway.ts). A grant can be the FIRST touch an automation's
   * agent gets (e.g. approved before any reconcile pass has run against it,
   * as the desktop UI's "Grant access" flow does), so without this,
   * `ensureAgentEnrolled` falls back to a bare `humanizeSlug(appId)` and the
   * agent is stuck with that id-derived name until some later reconcile
   * happens to touch it again.
   */
  approveAgentGrant(appId: string, request: GrantRequest, displayName?: string): string {
    const agent = ensureAgentEnrolled(this.db, appId, {
      modelRef: 'centraid-automation',
      ...(displayName ? { displayName } : {}),
    });
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
      actorId: r.actor_id,
      connection: { kind: r.kind, label: r.label },
      actor: this.actorName(r.actor_id, r.actor_kind),
      actorKind: this.refineActorKind(r.actor_id, r.actor_kind),
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

  /**
   * One outbox item's verb + artifact + request, read directly off the
   * row — SERVER-SIDE ONLY. Never rides `GET /outbox` or `GET /blocking`
   * (this class's `listOutbox` deliberately omits `request_json`; see its
   * doc comment). The edit-before-approve route (`outbox-edit.ts`) uses
   * this to rebuild a wire request from an owner-edited artifact without
   * ever handing the raw request to the owner surface.
   */
  rawOutboxItem(
    itemId: string,
  ):
    | { verb: string; artifact: Record<string, unknown>; request: Record<string, unknown> }
    | undefined {
    const row = this.db.vault
      .prepare('SELECT verb, artifact_json, request_json FROM outbox_item WHERE item_id = ?')
      .get(itemId) as { verb: string; artifact_json: string; request_json: string } | undefined;
    if (!row) return undefined;
    return {
      verb: row.verb,
      artifact: JSON.parse(row.artifact_json) as Record<string, unknown>,
      request: JSON.parse(row.request_json) as Record<string, unknown>,
    };
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

  /**
   * Refines a stored `ai_agent` actor into `assistant` vs `agent` the same
   * way `Gateway.callerKind` does for parked rows (`host_key '_assistant'`),
   * so the Approvals surface badges assistant-staged sends honestly.
   */
  private refineActorKind(actorId: string, actorKind: string): string {
    if (actorKind !== 'ai_agent') return actorKind;
    const row = this.db.vault
      .prepare('SELECT host_key FROM agent_agent WHERE agent_id = ?')
      .get(actorId) as { host_key: string } | undefined;
    return row?.host_key === '_assistant' ? 'assistant' : 'agent';
  }

  /** Display name for an outbox actor row id (agent party / app name). */
  private actorName(actorId: string, actorKind: string): string | null {
    if (actorKind === 'owner') return 'owner';
    const row = this.db.vault
      .prepare(
        actorKind === 'app'
          ? 'SELECT COALESCE(display_name, name) AS name FROM consent_app WHERE app_id = ?'
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
    const agent = ensureAgentEnrolled(this.db, '_assistant', {
      modelRef: 'centraid-assistant',
      displayName: 'Assistant',
    });
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
            // Matched on `callerId` (the enrolled row id), not `caller` (a
            // display name — no longer guaranteed to equal `appId`).
            return this.gateway
              .listParked()
              .filter((p) => p.callerKind === 'app' && p.callerId === app.appId);
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
            // sees WHAT is pending, never another caller's business. Matched
            // on `callerId` (the enrolled row id), not `caller` (a display
            // name — no longer guaranteed to equal `appId`).
            return this.gateway
              .listParked()
              .filter((p) => p.callerKind === 'agent' && p.callerId === agent.agentId);
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

  // The no-shipper fallback checkpoints at 4x the shipper's default group
  // threshold — late enough never to fire while a healthy shipper exists.
  static readonly FALLBACK_CHECKPOINT_WAL_BYTES = 64 * 1024 * 1024;

  /**
   * One WAL capture tick (issue #408). Public so the BackupService's drain
   * loop and tests can force a capture at a known instant; the plane's own
   * `walTimer` is just this on a 60 s clock.
   */
  walTick(): void {
    if (this.closed) return;
    // Admin registries and a lease-conflicted second gateway may open the
    // databases, but must never capture, checkpoint, or mutate shipper state.
    if (!this.ownsWalLifecycle) return;
    if (!this.walShipper) {
      // No shipper (its construction failed on a file-backed vault) — but
      // `wal_autocheckpoint = 0` is set on every connection regardless, so
      // WITHOUT a checkpointer the WALs would grow unboundedly for the
      // whole gateway uptime. Fall back to a plain bounded checkpoint.
      try {
        const wal = path.join(this.dir, 'vault.db-wal');
        const jwal = path.join(this.dir, 'journal.db-wal');
        const oversized = (p: string) =>
          existsSync(p) && statSync(p).size > VaultPlane.FALLBACK_CHECKPOINT_WAL_BYTES;
        if (oversized(wal) || oversized(jwal)) {
          this.gateway.checkpoint(this.ownerCredential);
          this.logger.warn(
            'vault plane: WAL checkpointed by fallback (no wal shipper — backups are NOT capturing this vault)',
          );
        }
      } catch (err) {
        this.logger.warn(
          `vault plane: fallback checkpoint failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    try {
      const report = this.walShipper.tick();
      for (const brk of report.breaks) {
        this.logger.warn(`vault plane: wal generation break (${brk.db}: ${brk.reason})`);
      }
      for (const err of report.errors) {
        this.logger.warn(`vault plane: wal capture error (${err.db}): ${err.message}`);
      }
    } catch (err) {
      this.logger.warn(
        `vault plane: wal tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Begin the standing-duty clocks: a sweep now, then one per interval;
   *  WAL capture (issue #408) now, then one per `walTickMs`. */
  start(): void {
    this.runSweep();
    this.sweepTimer = setInterval(() => this.runSweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
    if (!this.ownsWalLifecycle) return;
    // Issue #411 action 3: defer the first capture off the mount critical
    // path. On a fresh vault the first tick mints the generation base — a
    // TRUNCATE checkpoint + reflink base clone + fsync + sha256 (~150-200 ms
    // /db, #408) — and mount awaits start(). setImmediate runs it after the
    // current I/O phase, so mount only REGISTERS the db; the base is built
    // just after. Correctness is unaffected: a generation is not advertised
    // to the provider until its base exists (basePending), and BackupService
    // drives walTick() itself before registering when bases aren't yet
    // coordinated (backup-service.ts ~:283) — so a backup racing ahead of
    // this deferred tick still mints its own base. walTick() is closed-guarded
    // (a stop() before the immediate fires makes it a no-op); we also clear
    // the handle in stop() to mirror the walTimer teardown.
    this.firstWalTick = setImmediate(() => {
      this.firstWalTick = undefined;
      this.walTick();
    });
    this.firstWalTick.unref();
    this.walTimer = setInterval(() => this.walTick(), this.walTickMs);
    this.walTimer.unref();
  }

  private runSweep(): void {
    try {
      const result = this.sweep();
      const touched =
        result.grantsExpired +
        result.sharesExpired +
        result.contentPurged +
        result.notesPurged +
        result.documentsPurged +
        result.retentionDeleted +
        result.blobsReclaimed +
        result.stagingExpired;
      if (touched > 0) {
        this.logger.info(
          `vault plane: sweep grantsExpired=${result.grantsExpired} sharesExpired=${result.sharesExpired} ` +
            `contentPurged=${result.contentPurged} notesPurged=${result.notesPurged} ` +
            `documentsPurged=${result.documentsPurged} retentionDeleted=${result.retentionDeleted} ` +
            `blobsReclaimed=${result.blobsReclaimed} stagingExpired=${result.stagingExpired}`,
        );
      }
      // Blob custody maintenance (issue #296): replicate to the remote tier
      // and reconcile orphans, detached — remote latency never blocks the
      // lifecycle sweep, and a vault with no remote tier no-ops.
      //
      // Failure backoff (issue #367 §C5): a sweep that keeps throwing (dead
      // credentials, an unreachable endpoint) would otherwise re-attempt on
      // every lifecycle tick — fine at the default hourly cadence, a hot
      // loop at a test's shortened one. `BlobSweepStatus.lastAttemptedAt`
      // (stamped by `reconcile()` itself, success or failure) is the clock;
      // a flat window scaled by consecutive failures and capped, matching
      // this codebase's other backoffs (`MOUNT_RETRY_BACKOFF_MS`) rather
      // than an unbounded exponential ramp.
      const sweepStatus = this.db.blobs.sweepStatus();
      const backoff = blobSweepBackoff(sweepStatus, Date.now());
      if (backoff.skip) {
        this.logger.warn(
          `vault plane: blob sweep backing off after ${sweepStatus.consecutiveFailures} ` +
            `consecutive failure(s) — next attempt in ${Math.ceil(backoff.retryInMs / 1000)}s`,
        );
      } else {
        this.runBlobSweep();
      }
      // Journal segment archival (issue #367 §E2): slow-cadence — at most
      // once per day per plane; the 90-day window makes it a no-op on young
      // vaults, and the segments it writes join the blob CAS, so the sweep
      // above replicates them remotely on the next pass.
      if (Date.now() - this.lastJournalArchivalAt >= JOURNAL_ARCHIVAL_MIN_INTERVAL_MS) {
        this.lastJournalArchivalAt = Date.now();
        try {
          // Ship the journal's pending WAL bytes BEFORE archival: the
          // archival VACUUM rewrites the whole file through the WAL, and a
          // generation roll right after (below) absorbs that rewrite into a
          // fresh, now-smaller base instead of shipping a DB-sized WAL
          // burst (issue #408 — journal archival is the one sanctioned bulk
          // rewrite of a shipped database).
          this.walTick();
          const archived = runJournalArchival(this.db);
          if (archived.rowsArchived > 0) {
            this.logger.info(
              `vault plane: journal archival rowsArchived=${archived.rowsArchived} ` +
                `manifests=${archived.manifests.length} vacuum=${archived.reclaim.mode}`,
            );
            // captureFirst: false — the JOURNAL's WAL right now holds the
            // archival VACUUM's whole-database rewrite; the fresh base the
            // roll takes already contains every byte of it, so capturing
            // first would ship a DB-sized burst into a generation whose next
            // event is its own retirement. (The VAULT's pending bytes still
            // ship: the flag names one database, and the vault's WAL holds
            // nothing unusual.)
            //
            // This re-bases the VAULT too, and that is required, not
            // incidental (issue #408): the two generations break together or
            // the snapshot that follows would pair a journal base from after
            // the archival with a vault base from before it — two instants,
            // no coordinated restore point between them, and the producer
            // refuses to register such a pair at all.
            this.walShipper?.rollGeneration('journal', 'journal-archival', { captureFirst: false });
          }
        } catch (err) {
          this.logger.warn(
            `vault plane: journal archival failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(
        `vault plane: sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * The blob-custody half of `runSweep`, split out so the failure-backoff
   * check above can skip it without a nested detached-promise indent. Lease
   * gating (issue #367 §C6): the orphan-DELETE phase pauses while a second
   * gateway instance appears live against this vault root — pushing new
   * replicas and detecting missing shas still runs either way.
   */
  private runBlobSweep(): void {
    void this.gateway
      .sweepBlobs(this.ownerCredential, { skipOrphanDelete: this.leaseConflicted() })
      .then((blobs) => {
        if (
          blobs.replicated.length +
            blobs.orphansDeleted.length +
            blobs.orphansSkipped.length +
            blobs.missing.length >
          0
        ) {
          this.logger.info(
            `vault plane: blob sweep replicated=${blobs.replicated.length} ` +
              `orphansDeleted=${blobs.orphansDeleted.length} orphansSkipped=${blobs.orphansSkipped.length} ` +
              `missing=${blobs.missing.length}`,
          );
        }
      })
      .catch((err: unknown) => {
        this.logger.warn(
          `vault plane: blob sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /** Stop the clocks, checkpoint the WALs, close the files. Idempotent. */
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.walTimer) clearInterval(this.walTimer);
    if (this.firstWalTick) clearImmediate(this.firstWalTick);
    if (this.walShipper) {
      // Shipper-owned shutdown (issue #408): run optimize + a final ship +
      // TRUNCATE inside the shipper (invariant I2 — it is the only
      // checkpointer), then close the handles without a second optimize
      // (whose WAL writes would be folded by SQLite's close-checkpoint
      // behind the shipper's back — a spurious foreign-checkpoint per
      // restart).
      try {
        this.walShipper.close();
      } catch (err) {
        this.logger.warn(
          `vault plane: wal shipper close failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      this.db.close({ skipOptimize: true });
      return;
    }
    if (this.ownsWalLifecycle) {
      try {
        this.gateway.checkpoint(this.ownerCredential);
      } catch (err) {
        this.logger.warn(
          `vault plane: checkpoint on stop failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // A non-owner must not run optimize/checkpoint work during close either.
    this.db.close({ skipOptimize: !this.ownsWalLifecycle });
  }
}

export function openVaultPlane(options: VaultPlaneOptions): VaultPlane {
  return new VaultPlane(options);
}
