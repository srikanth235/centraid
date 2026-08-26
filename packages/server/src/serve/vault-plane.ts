// governance: allow-repo-hygiene file-size-limit one cohesive plane (mount + both bridge planes + workspace accessors, #280; #282 adds anchorAsOwner, a one-line delegation like its link/unlink siblings); pending split of the bridge executors into a sibling module
/*
 * The vault plane (duality §12) — the gateway's mount of the owner's vault.
 *
 * The gateway process is the SOLE holder of the vault connection. Apps reach
 * it only through `ctx.vault`, and the running app is resolved to its enrolled
 * `consent.app` credential HERE, host-side: no signing key ever crosses into a
 * handler worker. Consent, contracts, receipts and provenance are the vault
 * gateway's own pipeline; this module adds nothing and takes nothing away.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  ensureConversationLedger,
  runConversationArchival,
  repriceLedger,
} from "@centraid/server/engine";
import type {
  RuntimeLogger,
  VaultBridge,
  VaultCallResult,
  VaultWorkspace,
} from "@centraid/server/engine";
import {
  assertExtSchemaOwnership,
  buildAssistantContext,
  createGateway,
  createGrant,
  ensureAgentEnrolled,
  ensureAppEnrolled,
  bootstrapVault,
  recoverVaultBootstrap,
  GatewayError,
  listActiveAgentGrants,
  listActiveGrants,
  listEnrolledAgents,
  listEnrolledApps,
  listInstalledApps,
  setAppLabel,
  lookupAgentByName,
  lookupAppByName,
  markAgentRevoked,
  markAppRevoked,
  openVaultDb,
  purposeConceptId,
  clearAllScopeTombstones,
  clearScopeTombstones,
  checkpointVault,
  deleteReplicaIntentOutcomesForDevice,
  closeObsoleteScopeRequest,
  getOpenScopeRequest,
  hasGrantHistory,
  listOpenScopeRequests,
  listScopeTombstones,
  markScopeRequestDecided,
  openScopeRequest,
  writeScopeTombstones,
  renameVault,
  readVaultPresentation,
  readVaultPersonal,
  markVaultPersonal,
  readBackupPolicy,
  updateVaultPresentation,
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
  registerMediaGazetteerCommands,
  registerPartyCommands,
  registerPeopleCommands,
  registerScheduleCommands,
  registerSocialCommands,
  registerOutboxCommands,
  registerJudgmentCommands,
  registerSyncCommands,
  registerTallyCommands,
  registerTaskCommands,
  registerAtlasCommands,
  pruneReplicaChanges,
  runJournalArchival,
  blobCustodyProven,
  WalShipper,
  jitterDelayMs,
  scopeCovers,
  sweepLocalOrphans,
  decideVaultMaintenance,
  runVaultMaintenance,
  vaultFileBytes,
} from "@centraid/vault";
import type {
  VaultFootprintBudget,
  InstalledAppRow,
  ScopeRequestSummary,
  ScopeTriple,
  VaultPresentation,
  AgentSummary,
  AppSummary,
  ChangesRequest,
  Credential,
  Gateway as VaultGateway,
  GrantSummary,
  HostBootstrap,
  InvokeOutcome,
  InvokeRequest,
  LockerAuthRequest,
  ParkedSummary,
  ReadRequest,
  RefRequest,
  RevealRequest,
  RevocationResult,
  ScopeSpec,
  SearchRequest,
  SweepResult,
  VaultDb,
  VaultSqlResult,
  ResolveResult,
  ExtApplyOutcome,
  ExtTableSpec,
  DemoPurgeResult,
  BlobStoreSettings,
  S3Credentials,
  PreviewCodec,
  KeyStore,
  WalShipperOptions,
} from "@centraid/vault";

import { loadSqliteVec } from "../enrich/sqlite-vec.js";
import { GroupCommitQueue } from "./group-commit-queue.js";
import { decideJournalArchive } from "./journal-limit.js";
import { NoticeStore } from "./notices.js";
import { replicaIntentContext } from "./replica-intent-context.js";
import { vaultContext } from "./vault-context.js";
import { pickAnchors, pickEntities } from "./vault-picker.js";
import type {
  AnchorPickerHit,
  AnchorSelector,
  LinkInput,
  PickerHit,
  PickerRequest,
} from "./vault-picker.js";
import { applyRestoreQuarantine } from "./vault-quarantine.js";
import type { QuarantineStatus } from "./vault-quarantine.js";

/** For a vault with no backup provider (#599). */
const LOCAL_ORPHAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const BLOB_SWEEP_BACKOFF_STEP_MS = 60_000;
const BLOB_SWEEP_MAX_BACKOFF_MS = 30 * 60_000;

/** The window runs from the last ATTEMPT, not the last success. */
export function blobSweepBackoff(
  status: { consecutiveFailures: number; lastAttemptedAt: string | null },
  nowMs: number
): { skip: boolean; retryInMs: number } {
  if (status.consecutiveFailures <= 0 || !status.lastAttemptedAt)
    return { skip: false, retryInMs: 0 };
  const backoffMs = Math.min(
    BLOB_SWEEP_BACKOFF_STEP_MS * status.consecutiveFailures,
    BLOB_SWEEP_MAX_BACKOFF_MS
  );
  const dueAtMs = Date.parse(status.lastAttemptedAt) + backoffMs;
  const retryInMs = dueAtMs - nowMs;
  return retryInMs > 0
    ? { skip: true, retryInMs }
    : { skip: false, retryInMs: 0 };
}

function defaultEnvS3Credentials(): Promise<S3Credentials> {
  const accessKeyId = process.env.CENTRAID_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.CENTRAID_S3_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) {
    return Promise.reject(
      new Error(
        "s3 blob store configured but CENTRAID_S3_ACCESS_KEY_ID / CENTRAID_S3_SECRET_ACCESS_KEY are not in the gateway environment (issue #296: creds are harness-ambient, never settings)"
      )
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
  dir: string;
  /** DISPOSABLE cache OUTSIDE the vault tree: safe to wipe, never backed up
   *  with the sovereign pair. */
  cacheDir?: string;
  logger: RuntimeLogger;
  ownerName?: string;
  bootstrap?: boolean;
  keyStore?: KeyStore;
  vaultId?: string;
  vaultName?: string;
  sweepIntervalMs?: number;
  walTickMs?: number;
  enableWalShipper?: boolean;
  /** Gates the CAPTURE CLOCK only: WAL ownership and the shipper object stay
   *  unconditional while the process owns the vault. */
  walCaptureConfigured?: () => boolean;
  walShipper?: Partial<Omit<WalShipperOptions, "db" | "log">>;
  skipOrphanDelete?: () => boolean;
  /** Defaults to the harness-ambient `CENTRAID_S3_*` lane (#296). */
  s3Credentials?: (settings: BlobStoreSettings) => Promise<S3Credentials>;
  previewCodec?: PreviewCodec;
  onProvenanceCommitted?: (
    vaultId: string,
    entityTypes?: readonly string[]
  ) => void;
  onCommonsCommandSequenced?: (vaultId: string, grantId: string) => void;
  onCommonsIntentQueued?: (vaultId: string, grantId: string) => void;
  onNotificationsChanged?: (vaultId: string, wake: boolean) => void;
  synchronous?: "FULL" | "NORMAL";
  shouldDeferBackgroundWork?: () => boolean;
  replicationConcurrency?: number;
  onSweepPass?: (info: { durationMs: number }) => void;
  onReplicationPass?: (info: {
    bytesReplicated: number;
    durationMs: number;
  }) => void;
  /** Read fresh EVERY sweep, so a limit change lands without a remount.
   *  `null` ⇒ time-only cadence. */
  journalLimitBytes?: () => number | null;
  vaultLimitBytes?: () => number | null;
  /** A TOTAL across both databases, so the host divides one ceiling by the
   *  mounted-plane count and does no other arithmetic (#659). */
  footprint?: Partial<VaultFootprintBudget>;
}

export interface GrantRequest {
  purpose: string;
  scopes: ScopeSpec[];
  expiresAt?: string;
}

export interface InstallScopeBlock {
  purpose?: string;
  scopes: readonly {
    schema: string;
    table?: string;
    verbs: ScopeSpec["verbs"];
    rowFilter?: ScopeSpec["rowFilter"];
    fieldMask?: ScopeSpec["fieldMask"];
  }[];
}

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

export interface ReviewEntry {
  receiptId: string;
  action: string;
  objectType: string;
  objectId: string | null;
  decision: string;
  occurredAt: string;
  risk: string | null;
  invocationId: string | null;
  actorId: string | null;
  actorKind: string | null;
  actor: string | null;
  /** The STANDING grant that auto-allowed this receipt; distinct from
   *  `consent.access_grant` on the row (#552). */
  grantId: string | null;
  context: { kind: "fill"; origin: string } | null;
}

function asVaultCallResult(fn: () => unknown): VaultCallResult {
  try {
    return { ok: true, result: fn() };
  } catch (error) {
    if (error instanceof GatewayError) {
      return {
        ok: false,
        code: `VAULT_${error.stage.toUpperCase()}`,
        error: error.message,
      };
    }
    return {
      ok: false,
      code: "VAULT_ERROR",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Tombstoned scopes are the owner's standing "no" (#308). `scopeCovers` is the
 * vault package's CANONICAL extent comparison, never a local copy: one
 * definition keeps consent memory and install-grant reconciliation in
 * lockstep (#541).
 */
function missingScopes(
  grants: GrantSummary[],
  declared: InstallScopeBlock["scopes"],
  tombstoned: readonly ScopeTriple[] = []
): ScopeSpec[] {
  return declared
    .filter(
      (scope) =>
        !grants.some((grant) =>
          grant.scopes.some((existing) => scopeCovers(existing, scope))
        ) && !tombstoned.some((existing) => scopeCovers(existing, scope))
    )
    .map((s) => ({
      schema: s.schema,
      ...(s.table === undefined ? {} : { table: s.table }),
      verbs: s.verbs,
      ...(s.rowFilter ? { rowFilter: [...s.rowFilter] } : {}),
      ...(s.fieldMask ? { fieldMask: [...s.fieldMask] } : {}),
    }));
}

interface AgentContentRequest {
  contentId: string;
  variant: string;
  maxBytes?: number;
  purpose?: string;
}

async function asVaultCallResultAsync(
  fn: () => Promise<unknown>
): Promise<VaultCallResult> {
  try {
    return { ok: true, result: await fn() };
  } catch (error) {
    if (error instanceof GatewayError) {
      return {
        ok: false,
        code: `VAULT_${error.stage.toUpperCase()}`,
        error: error.message,
      };
    }
    return {
      ok: false,
      code: "VAULT_ERROR",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const JOURNAL_ARCHIVAL_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const VAULT_MAINTENANCE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Sized for bounded work on the CONSTRAINED host (#659). */
const LOCAL_ORPHAN_SWEEP_MAX_ENTRIES = 2_000;

/**
 * Both fields are HOST-resolved and re-set by the caller (#599).
 * `intentDeviceId` is the ONLY thing the vault checks when an app claims a
 * replica intent, so a caller-supplied one could settle another device's
 * queued write as its own. Stripping makes the check compare host truth
 * against stored truth, and fails closed with no device.
 */
function withoutForgedIdentity(payload: InvokeRequest): InvokeRequest {
  const { actingOwnerId: _owner, intentDeviceId: _device, ...rest } = payload;
  return rest;
}

/** An agent NEVER runs under a replica intent, so any `intentId` reaching
 *  this bridge is caller-invented and is dropped. */
function withoutAgentIntent(payload: InvokeRequest): InvokeRequest {
  const { intentId: _claimed, ...rest } = payload;
  return rest;
}

export class VaultPlane {
  readonly db: VaultDb;
  readonly gateway: VaultGateway;
  readonly boot: HostBootstrap;
  readonly notices: NoticeStore;
  readonly dir: string;
  readonly cacheDir: string;
  private readonly groupCommitQueue: GroupCommitQueue;
  readonly quarantine: QuarantineStatus | null;
  /** The capture clock sleeps until a backup destination exists (#408). */
  walShipper: WalShipper | undefined;
  private readonly logger: RuntimeLogger;
  private readonly sweepIntervalMs: number;
  private readonly walTickOverrideMs: number | undefined;
  private readonly skipOrphanDelete: () => boolean;
  private readonly walLifecycleEnabled: boolean;
  private readonly walCaptureConfigured: () => boolean;
  private readonly walShipperOptions: NonNullable<
    VaultPlaneOptions["walShipper"]
  >;
  private readonly shouldDeferBackgroundWork: () => boolean;
  private readonly onSweepPass:
    | ((info: { durationMs: number }) => void)
    | undefined;
  private readonly onReplicationPass:
    | ((info: { bytesReplicated: number; durationMs: number }) => void)
    | undefined;
  private readonly onNotificationsChanged:
    | ((vaultId: string, wake: boolean) => void)
    | undefined;
  private sweepTimer: NodeJS.Timeout | undefined;
  private firstSweep: NodeJS.Immediate | undefined;
  private walTimer: NodeJS.Timeout | undefined;
  private firstWalTick: NodeJS.Immediate | undefined;
  private lastJournalArchivalAt = 0;
  private readonly journalLimitBytes: () => number | null;
  private journalArchiveRung = 0;
  private lastVaultMaintenanceAt = 0;
  private readonly vaultLimitBytes: () => number | null;
  private vaultMaintenanceRung = 0;
  /** In memory BY DESIGN: restarting at the top costs a pass, not
   *  correctness. */
  private localOrphanCursor: string | null = null;
  private repriceCursor = 0;
  private closed = false;
  private displayName: string;
  /** GC roots, so an orphan-delete can never evict an object a recovery-to-N
   *  still needs. A supplier that THROWS fails safe: the delete phase is
   *  skipped rather than run against an incomplete root set (#436). */
  snapshotBlobRoots?: () => Promise<ReadonlySet<string>>;
  /**
   * The recovery window N in ms, or `undefined` when none is knowable (#439).
   * The orphan delete waits N past first-observed-orphaned before evicting a
   * byte a recovery-to-N would replay. Unset ⇒ orphans delete immediately.
   * When the supplier THROWS the sweep fails safe: nothing deletes.
   */
  orphanGraceWindowMs?: () => Promise<number | undefined>;
  /** The workspace serves the SAME `journal.db` connection the audit stream
   *  uses; the ledger DDL is idempotent and never touches the audit ladder's
   *  user_version, so ensuring lazily is safe. */
  private ledgerReady = false;
  private personalFlag: boolean | undefined;

  constructor(options: VaultPlaneOptions) {
    this.logger = options.logger;
    this.sweepIntervalMs = options.sweepIntervalMs ?? 60 * 60 * 1000;
    this.skipOrphanDelete = options.skipOrphanDelete ?? (() => false);
    this.shouldDeferBackgroundWork =
      options.shouldDeferBackgroundWork ?? (() => false);
    this.onSweepPass = options.onSweepPass;
    this.onReplicationPass = options.onReplicationPass;
    this.journalLimitBytes = options.journalLimitBytes ?? (() => null);
    this.vaultLimitBytes = options.vaultLimitBytes ?? (() => null);
    this.dir = options.dir;
    this.cacheDir = options.cacheDir ?? options.dir;
    this.db = openVaultDb({
      dir: options.dir,
      ...(options.keyStore ? { keyStore: options.keyStore } : {}),
      s3Credentials: options.s3Credentials ?? defaultEnvS3Credentials,
      ...(options.previewCodec ? { previewCodec: options.previewCodec } : {}),
      // A platform without the extension falls back to the exact JS cosine
      // scan and NEVER fails the open (#721).
      loadExtensions: (db) => {
        loadSqliteVec(db, (reason) => {
          this.logger.info(
            `vault plane: vector search extension unavailable (${reason}) — ` +
              "semantic search falls back to the exact cosine scan"
          );
        });
      },
      shouldDeferBackgroundWork: this.shouldDeferBackgroundWork,
      ...(options.replicationConcurrency === undefined
        ? {}
        : { replicationConcurrency: options.replicationConcurrency }),
      ...(options.synchronous ? { synchronous: options.synchronous } : {}),
      ...(options.footprint ? { footprint: options.footprint } : {}),
    });
    const recovered = recoverVaultBootstrap(this.db);
    if (recovered) {
      this.boot = recovered;
    } else if (options.bootstrap) {
      this.boot = {
        ...bootstrapVault(this.db, {
          ownerName: options.ownerName ?? "Owner",
          ...(options.vaultId ? { vaultId: options.vaultId } : {}),
          ...(options.vaultName ? { vaultName: options.vaultName } : {}),
        }),
        fresh: true,
      };
    } else {
      this.db.close();
      throw new Error(
        `vault at ${options.dir} holds no vault; creating one is an admin act through VaultRegistry.create`
      );
    }
    this.displayName = this.boot.displayName;
    this.onNotificationsChanged = options.onNotificationsChanged;
    this.notices = new NoticeStore(this.db.vault, ({ wake }) =>
      this.ringNotificationsChanged(wake)
    );
    this.gateway = createGateway(this.db, {
      ...(options.onProvenanceCommitted
        ? {
            onProvenanceCommitted: (entityTypes?: readonly string[]) =>
              options.onProvenanceCommitted?.(this.boot.vaultId, entityTypes),
          }
        : {}),
      ...(options.onNotificationsChanged
        ? {
            onDecisionChanged: (created: boolean) =>
              this.ringNotificationsChanged(created),
          }
        : {}),
      ...(options.onCommonsCommandSequenced
        ? {
            onCommonsCommandSequenced: (grantId: string) =>
              options.onCommonsCommandSequenced?.(this.boot.vaultId, grantId),
          }
        : {}),
      ...(options.onCommonsIntentQueued
        ? {
            onCommonsIntentQueued: (grantId: string) =>
              options.onCommonsIntentQueued?.(this.boot.vaultId, grantId),
          }
        : {}),
    });
    this.groupCommitQueue = new GroupCommitQueue(
      options.synchronous === "NORMAL" ? 8 : 5,
      (runs) => this.gateway.invokeBatchSettled(runs)
    );
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
    registerMediaGazetteerCommands(this.gateway);
    registerDocumentCommands(this.gateway);
    registerHomeCommands(this.gateway);
    registerPeopleCommands(this.gateway);
    registerLockerCommands(this.gateway);
    registerTallyCommands(this.gateway);
    registerSyncCommands(this.gateway);
    registerEnrichCommands(this.gateway);
    registerOutboxCommands(this.gateway);
    registerJudgmentCommands(this.gateway);
    registerAtlasCommands(this.gateway);
    // Handlers live in gateway memory, contract rows in the vault, so every
    // installed app's ext trios must be re-armed here (#286).
    this.gateway.registerAllExtCommands();
    // The ONE safe early checkpoint: the shipper has not attached yet.
    if (this.boot.fresh) checkpointVault(this.db);
    this.logger.info(
      this.boot.fresh
        ? `vault plane: bootstrapped a fresh vault at ${options.dir}`
        : `vault plane: recovered vault ${this.boot.vaultId} at ${options.dir}`
    );
    if (existsSync(path.join(options.dir, "transcripts.db"))) {
      this.logger.warn(
        `vault plane: ignoring legacy transcripts.db at ${options.dir} — ` +
          "the conversation ledger folded into journal.db"
      );
    }
    // FORMAT.md rule 4; the automations gap stays manual by design.
    this.quarantine = applyRestoreQuarantine(options.dir, this.db, this.logger);
    if ((this.quarantine?.outboxParked ?? 0) > 0) {
      this.ringNotificationsChanged(true);
    }
    // A restored directory mints a fresh generation on its first tick — the
    // stream break FORMAT.md rule 6 requires.
    this.walTickOverrideMs = options.walTickMs;
    this.walLifecycleEnabled = options.enableWalShipper !== false;
    this.walCaptureConfigured = options.walCaptureConfigured ?? (() => true);
    this.walShipperOptions = options.walShipper ?? {};
    this.walShipper = this.createWalShipperIfOwner();
  }

  private ownsWalLifecycle(): boolean {
    return this.walLifecycleEnabled;
  }

  private createWalShipperIfOwner(): WalShipper | undefined {
    if (!this.ownsWalLifecycle()) return undefined;
    try {
      return new WalShipper({
        db: this.db,
        walSizeThresholdBytes: () =>
          readBackupPolicy(this.db.vault).walBaseRollBytes,
        baseIntervalMs: () =>
          readBackupPolicy(this.db.vault).walBaseRollHours * 60 * 60 * 1000,
        log: {
          info: (m) => this.logger.info(m),
          warn: (m) => this.logger.warn(m),
        },
        ...this.walShipperOptions,
      });
    } catch (error) {
      if (this.dir !== ":memory:") {
        this.logger.warn(
          `vault plane: wal shipper unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return undefined;
    }
  }

  private ensureWalShipper(): void {
    this.walShipper ??= this.createWalShipperIfOwner();
  }

  get ownerCredential(): Credential {
    return {
      kind: "device",
      deviceId: this.boot.deviceId,
      deviceKey: this.boot.deviceKey,
    };
  }

  get name(): string {
    return this.displayName;
  }

  /** The ledger and per-app dirs live BESIDE the sovereign pair; the harness
   *  scratch is the exception, in `cacheDir` outside the tree (#280). */
  get workspace(): VaultWorkspace {
    return {
      vaultId: this.boot.vaultId,
      ownerPartyId: this.boot.ownerPartyId,
      appsDir: path.join(this.dir, "apps"),
      journal: () => this.journalLedger(),
      journalDbFile: path.join(this.dir, "journal.db"),
      harnessSessionDir: path.join(this.cacheDir, "harness-sessions"),
    };
  }

  get codeStoreRoot(): string {
    return path.join(this.dir, "code");
  }

  private journalLedger(): DatabaseSync {
    if (this.closed)
      throw new Error(`vault plane ${this.boot.vaultId} is stopped`);
    if (!this.ledgerReady) {
      ensureConversationLedger(this.db.journal);
      this.ledgerReady = true;
    }
    return this.db.journal;
  }

  rename(name: string): void {
    renameVault(this.db, name);
    this.displayName = name;
    this.logger.info(
      `vault plane: renamed vault ${this.boot.vaultId} to "${name}"`
    );
  }

  get presentation(): VaultPresentation {
    return readVaultPresentation(this.db);
  }

  /** Memoized and NEVER throwing: `defaultVaultId()` consults this on every
   *  unscoped request, so an unreadable plane must not take down routing —
   *  it simply is not the default. */
  get personal(): boolean {
    if (this.personalFlag === undefined) {
      try {
        this.personalFlag = readVaultPersonal(this.db);
      } catch {
        return false;
      }
    }
    return this.personalFlag;
  }

  markPersonal(): void {
    markVaultPersonal(this.db);
    this.personalFlag = true;
  }

  updatePresentation(
    patch: Partial<Record<"color" | "icon" | "blurb", string | null>>
  ): VaultPresentation {
    return updateVaultPresentation(this.db, patch);
  }

  enrollApp(appId: string): void {
    const enrolled = ensureAppEnrolled(this.db, appId, { origin: "generated" });
    if (enrolled.created)
      this.logger.info(`vault plane: enrolled app "${appId}"`);
  }

  /** Identity ONLY: declared scopes are granted by the install-time grant
   *  path (#434). */
  installApp(appId: string, displayName?: string): { created: boolean } {
    const enrolled = ensureAppEnrolled(this.db, appId, {
      origin: "installed",
      ...(displayName ? { displayName } : {}),
    });
    if (enrolled.created)
      this.logger.info(`vault plane: installed app "${appId}"`);
    return { created: enrolled.created };
  }

  installedAppIds(): Set<string> {
    return new Set(listInstalledApps(this.db).map((a) => a.name));
  }

  installedApps(): InstalledAppRow[] {
    return listInstalledApps(this.db);
  }

  setAppLabel(appId: string, label: string | null): void {
    setAppLabel(this.db, appId, label);
  }

  /** Automation fires ride an ENROLLED AGENT, never an app credential. */
  enrollAutomationAgent(appId: string, displayName?: string): void {
    const enrolled = ensureAgentEnrolled(this.db, appId, {
      modelRef: "centraid-automation",
      ...(displayName ? { displayName } : {}),
    });
    if (enrolled.created)
      this.logger.info(`vault plane: enrolled automation agent "${appId}"`);
  }

  /** The ext band is RETAINED: the data is the owner's and purge is a
   *  separate act. Model rows and receipts remain. */
  revokeApp(appId: string): { grantsRevoked: number } {
    const hadOpenScopeRequest = this.listScopeRequests().some(
      (request) => request.appId === appId
    );
    let revoked = 0;
    const app = lookupAppByName(this.db, appId);
    if (app) {
      for (const grant of listActiveGrants(this.db, app.appId)) {
        const result: RevocationResult = this.gateway.revokeGrant(
          this.ownerCredential,
          grant.grantId
        );
        revoked += 1;
        this.logger.info(
          `vault plane: revoked grant ${grant.grantId} for "${appId}" ` +
            `(views ${result.viewsRevoked}, parked ${result.parkedDropped})`
        );
      }
      markAppRevoked(this.db, app.appId);
    }
    const agent = lookupAgentByName(this.db, appId);
    if (agent) {
      for (const grant of listActiveAgentGrants(this.db, agent.partyId)) {
        this.gateway.revokeGrant(this.ownerCredential, grant.grantId);
        revoked += 1;
        this.logger.info(
          `vault plane: revoked agent grant ${grant.grantId} for "${appId}"`
        );
      }
      markAgentRevoked(this.db, agent.agentId);
    }
    // Standing grants die WITH the actor (#306).
    const outboxRevocations: string[] = [];
    for (const actorId of [app?.appId, agent?.agentId]) {
      if (!actorId) continue;
      const rules = this.db.vault
        .prepare(
          "SELECT grant_id FROM outbox_grant WHERE actor_id = ? AND revoked_at IS NULL"
        )
        .all(actorId) as { grant_id: string }[];
      for (const rule of rules) {
        outboxRevocations.push(rule.grant_id);
      }
    }
    const revokeResults = this.gateway.invokeBatchSettled(
      outboxRevocations.map(
        (grantId) => () =>
          this.gateway.invoke(this.ownerCredential, {
            command: "outbox.revoke_grant",
            input: { grant_id: grantId },
          })
      )
    );
    for (const [index, result] of revokeResults.entries()) {
      if (!result.ok) throw result.error;
      const revokedGrantId = outboxRevocations[index]!;
      this.logger.info(
        `vault plane: revoked standing outbox grant ${revokedGrantId} for "${appId}"`
      );
    }
    // Uninstall WIPES the consent memory (#308): it is "no to the whole app",
    // not "no to these scopes forever" — a reinstall is a fresh consent.
    if (app) clearAllScopeTombstones(this.db, { appId: app.appId });
    if (agent)
      clearAllScopeTombstones(this.db, { granteePartyId: agent.partyId });
    closeObsoleteScopeRequest(this.db, "app", appId);
    closeObsoleteScopeRequest(this.db, "agent", appId);
    if (hadOpenScopeRequest) this.ringNotificationsChanged(false);
    return { grantsRevoked: revoked };
  }

  /** An app may request `ext.*` scopes only on its OWN band. */
  approveGrant(appId: string, request: GrantRequest): string {
    const app = ensureAppEnrolled(this.db, appId, { origin: "generated" });
    const purpose = purposeConceptId(this.db, request.purpose);
    if (!purpose)
      throw new Error(`unknown purpose notation "${request.purpose}"`);
    if (request.scopes.length === 0)
      throw new Error("a grant needs at least one scope");
    for (const scope of request.scopes)
      assertExtSchemaOwnership(appId, scope.schema);
    clearScopeTombstones(this.db, { appId: app.appId }, request.scopes);
    return createGrant(this.db, {
      appId: app.appId,
      purposeConceptId: purpose,
      grantedByPartyId: this.boot.ownerPartyId,
      scopes: request.scopes,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    });
  }

  /** A grant can be the FIRST touch an agent gets, and without `displayName`
   *  it is stuck with a bare `humanizeSlug(appId)` until a later reconcile. */
  approveAgentGrant(
    appId: string,
    request: GrantRequest,
    displayName?: string
  ): string {
    const agent = ensureAgentEnrolled(this.db, appId, {
      modelRef: "centraid-automation",
      ...(displayName ? { displayName } : {}),
    });
    const purpose = purposeConceptId(this.db, request.purpose);
    if (!purpose)
      throw new Error(`unknown purpose notation "${request.purpose}"`);
    if (request.scopes.length === 0)
      throw new Error("a grant needs at least one scope");
    clearScopeTombstones(
      this.db,
      { granteePartyId: agent.partyId },
      request.scopes
    );
    return createGrant(this.db, {
      granteePartyId: agent.partyId,
      purposeConceptId: purpose,
      grantedByPartyId: this.boot.ownerPartyId,
      scopes: request.scopes,
      ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
    });
  }

  /** Installing WAS the consent, for the scopes declared AT install. The
   *  top-up NEVER widens on its own afterwards: agents author their own
   *  manifests, so a re-publish would steer its own containment (#306). */
  ensureAppInstallGrant(appId: string, block: InstallScopeBlock): void {
    const app = ensureAppEnrolled(this.db, appId, { origin: "generated" });
    this.ensureInstallGrant({
      plane: "app",
      appId,
      block,
      grantee: { appId: app.appId },
      grants: listActiveGrants(this.db, app.appId),
      approve: (request) => void this.approveGrant(appId, request),
    });
  }

  ensureAgentInstallGrant(appId: string, block: InstallScopeBlock): void {
    const agent = ensureAgentEnrolled(this.db, appId, {
      modelRef: "centraid-automation",
    });
    this.ensureInstallGrant({
      plane: "agent",
      appId,
      block,
      grantee: { granteePartyId: agent.partyId },
      grants: listActiveAgentGrants(this.db, agent.partyId),
      approve: (request) => void this.approveAgentGrant(appId, request),
    });
  }

  private ensureInstallGrant(input: {
    plane: "app" | "agent";
    appId: string;
    block: InstallScopeBlock;
    grantee: { appId?: string; granteePartyId?: string };
    grants: GrantSummary[];
    approve: (request: GrantRequest) => void;
  }): void {
    const purpose = input.block.purpose ?? "dpv:ServiceProvision";
    const existingRequest = this.listScopeRequests().find(
      (request) =>
        request.plane === input.plane && request.appId === input.appId
    );
    const tombstoned = listScopeTombstones(this.db, input.grantee);
    const missing = missingScopes(input.grants, input.block.scopes, tombstoned);
    if (missing.length === 0) {
      closeObsoleteScopeRequest(this.db, input.plane, input.appId);
      if (existingRequest) this.ringNotificationsChanged(false);
      return;
    }
    if (!hasGrantHistory(this.db, input.grantee)) {
      input.approve({ purpose, scopes: missing });
      this.logger.info(
        `vault plane: install-time grant for ${input.plane} "${input.appId}" (+${missing.length} scope(s))`
      );
      return;
    }
    const nextScopes = missing.map((s) => ({
      schema: s.schema,
      ...(s.table === undefined ? {} : { table: s.table }),
      verbs: s.verbs,
      ...(s.rowFilter ? { rowFilter: [...s.rowFilter] } : {}),
      ...(s.fieldMask ? { fieldMask: [...s.fieldMask] } : {}),
    }));
    openScopeRequest(this.db, {
      plane: input.plane,
      appId: input.appId,
      purpose,
      scopes: nextScopes,
    });
    if (
      !existingRequest ||
      JSON.stringify(existingRequest.scopes) !== JSON.stringify(nextScopes)
    ) {
      this.ringNotificationsChanged(existingRequest === undefined);
    }
    this.logger.info(
      `vault plane: ${input.plane} "${input.appId}" asks for ${missing.length} scope(s) beyond its last consent — parked for the owner`
    );
  }

  listScopeRequests(): ScopeRequestSummary[] {
    return listOpenScopeRequests(this.db);
  }

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
          ...(s.table === undefined ? {} : { table: s.table }),
          verbs: s.verbs,
          ...(s.rowFilter ? { rowFilter: [...s.rowFilter] } : {}),
          ...(s.fieldMask ? { fieldMask: [...s.fieldMask] } : {}),
        })),
      };
      if (request.plane === "app")
        this.approveGrant(request.appId, grantRequest);
      else this.approveAgentGrant(request.appId, grantRequest);
    } else {
      writeScopeTombstones(this.db, grantee, request.scopes);
    }
    markScopeRequestDecided(
      this.db,
      requestId,
      approve ? "approved" : "denied"
    );
    this.ringNotificationsChanged(false);
    this.logger.info(
      `vault plane: owner ${approve ? "approved" : "denied"} the ${request.plane} "${request.appId}" scope request (${request.scopes.length} scope(s))`
    );
    return request;
  }

  private ringNotificationsChanged(wake: boolean): void {
    try {
      this.onNotificationsChanged?.(this.boot.vaultId, wake);
    } catch {
      // A listener's throw must not break the mutation that rang it.
    }
  }

  private granteeFor(request: ScopeRequestSummary): {
    appId?: string;
    granteePartyId?: string;
  } {
    if (request.plane === "app") {
      const app = ensureAppEnrolled(this.db, request.appId, {
        origin: "generated",
      });
      return { appId: app.appId };
    }
    const agent = ensureAgentEnrolled(this.db, request.appId, {
      modelRef: "centraid-automation",
    });
    return { granteePartyId: agent.partyId };
  }

  listApps(): Array<AppSummary & { grants: GrantSummary[] }> {
    return listEnrolledApps(this.db).map((app) => ({
      ...app,
      grants: listActiveGrants(this.db, app.appId),
    }));
  }

  listAgents(): Array<AgentSummary & { grants: GrantSummary[] }> {
    return listEnrolledAgents(this.db).map((agent) => ({
      ...agent,
      grants: listActiveAgentGrants(this.db, agent.partyId),
    }));
  }

  revokeGrant(grantId: string): RevocationResult {
    return this.gateway.revokeGrant(this.ownerCredential, grantId);
  }

  listParked(): ParkedSummary[] {
    return this.gateway.listParked();
  }

  pickEntities(request: PickerRequest): { cards: PickerHit[] } {
    return pickEntities(
      this.gateway,
      this.ownerCredential,
      this.logger,
      request
    );
  }

  pickAnchors(request: Pick<PickerRequest, "term" | "limit">): {
    anchors: AnchorPickerHit[];
  } {
    return pickAnchors(
      this.gateway,
      this.ownerCredential,
      this.logger,
      request
    );
  }

  linkAsOwner(input: LinkInput): Promise<InvokeOutcome> {
    return this.invoke(this.ownerCredential, {
      command: "core.link_entities",
      input: {
        from_type: input.from_type,
        from_id: input.from_id,
        to_type: input.to_type,
        to_id: input.to_id,
        relation: input.relation ?? "references",
        ...(input.selector ? { selector: input.selector } : {}),
      },
      purpose: "dpv:ServiceProvision",
    });
  }

  unlinkAsOwner(linkId: string): Promise<InvokeOutcome> {
    return this.invoke(this.ownerCredential, {
      command: "core.unlink_entities",
      input: { link_id: linkId },
      purpose: "dpv:ServiceProvision",
    });
  }

  anchorAsOwner(
    linkId: string,
    selector: AnchorSelector | null
  ): Promise<InvokeOutcome> {
    return this.invoke(this.ownerCredential, {
      command: "core.anchor_link",
      input: { link_id: linkId, ...(selector ? { selector } : {}) },
      purpose: "dpv:ServiceProvision",
    });
  }

  confirmParked(invocationId: string, approve: boolean): InvokeOutcome {
    return this.gateway.confirm(this.ownerCredential, invocationId, approve);
  }

  forgetReplicaDevice(deviceId: string): number {
    return deleteReplicaIntentOutcomesForDevice(this.db.vault, deviceId);
  }

  /** `request_json` stays SERVER-SIDE: it may carry placeholder plumbing the
   *  owner should never have to parse. */
  listOutbox(statuses?: readonly string[]): OutboxItemSummary[] {
    const filter = statuses && statuses.length > 0 ? statuses : null;
    const rows = this.db.vault
      .prepare(
        `SELECT i.item_id, i.actor_id, i.actor_kind, i.verb, i.target, i.artifact_json,
                i.status, i.grant_id, i.staged_at, i.decided_at, i.drained_at, i.result_json,
                i.note, c.kind, c.label
           FROM outbox_item i JOIN sync_connection c ON c.connection_id = i.connection_id
          ${filter ? `WHERE i.status IN (${filter.map(() => "?").join(", ")})` : ""}
          ORDER BY i.staged_at DESC LIMIT 500`
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
      result: r.result_json
        ? (JSON.parse(r.result_json) as Record<string, unknown>)
        : null,
      note: r.note,
    }));
  }

  /** SERVER-SIDE ONLY: never rides an owner-facing response. */
  rawOutboxItem(itemId: string):
    | {
        verb: string;
        artifact: Record<string, unknown>;
        request: Record<string, unknown>;
      }
    | undefined {
    const row = this.db.vault
      .prepare(
        "SELECT verb, artifact_json, request_json FROM outbox_item WHERE item_id = ?"
      )
      .get(itemId) as
      | { verb: string; artifact_json: string; request_json: string }
      | undefined;
    if (!row) return undefined;
    return {
      verb: row.verb,
      artifact: JSON.parse(row.artifact_json) as Record<string, unknown>,
      request: JSON.parse(row.request_json) as Record<string, unknown>,
    };
  }

  decideOutbox(input: {
    itemId: string;
    decision: "approve" | "discard";
    artifact?: Record<string, unknown>;
    request?: Record<string, unknown>;
    alwaysAllow?: boolean;
    note?: string;
  }): Promise<InvokeOutcome> {
    return this.invoke(this.ownerCredential, {
      command: "outbox.decide",
      input: {
        item_id: input.itemId,
        decision: input.decision,
        ...(input.artifact ? { artifact: input.artifact } : {}),
        ...(input.request ? { request: input.request } : {}),
        ...(input.alwaysAllow === undefined
          ? {}
          : { always_allow: input.alwaysAllow }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
  }

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
           FROM outbox_grant ORDER BY revoked_at IS NOT NULL, created_at DESC`
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
      actor:
        this.actorName(r.actor_id, "ai_agent") ??
        this.actorName(r.actor_id, "app"),
      actorId: r.actor_id,
      verb: r.verb,
      target: r.target,
      createdAt: r.created_at,
      revokedAt: r.revoked_at,
    }));
  }

  revokeOutboxGrant(grantId: string): Promise<InvokeOutcome> {
    return this.invoke(this.ownerCredential, {
      command: "outbox.revoke_grant",
      input: { grant_id: grantId },
    });
  }

  blocking(): {
    outbox: OutboxItemSummary[];
    needsAuth: Array<{
      connectionId: string;
      kind: string;
      label: string;
      note: string | null;
      attentionAt: string;
    }>;
    parked: ParkedSummary[];
    scopeRequests: ScopeRequestSummary[];
  } {
    const needsAuth = this.db.vault
      .prepare(
        `SELECT c.connection_id, c.kind, c.label, h.auth_note,
                coalesce(h.updated_at, c.created_at) AS attention_at
           FROM sync_connection c
           LEFT JOIN sync_connection_health h ON h.connection_id = c.connection_id
          WHERE c.status = 'needs-auth' ORDER BY c.kind, c.label`
      )
      .all() as {
      connection_id: string;
      kind: string;
      label: string;
      auth_note: string | null;
      attention_at: string;
    }[];
    return {
      outbox: this.listOutbox(["pending"]),
      needsAuth: needsAuth.map((r) => ({
        connectionId: r.connection_id,
        kind: r.kind,
        label: r.label,
        note: r.auth_note,
        attentionAt: r.attention_at,
      })),
      parked: this.listParked(),
      scopeRequests: this.listScopeRequests(),
    };
  }

  notificationsSummary(includeArchived = false): {
    decisions: ReturnType<VaultPlane["blocking"]> & { count: number };
    notices: ReturnType<NoticeStore["list"]>;
    unreadNoticeCount: number;
  } {
    const decisions = this.blocking();
    const count =
      decisions.outbox.length +
      decisions.needsAuth.length +
      decisions.parked.length +
      decisions.scopeRequests.length;
    const notices = this.notices.list({ includeArchived });
    return {
      decisions: { ...decisions, count },
      notices,
      unreadNoticeCount: notices.filter(
        (notice) => !notice.archivedAt && !notice.readAt
      ).length,
    };
  }

  reviewFeed(limit = 50): ReviewEntry[] {
    const window = this.db.journal
      .prepare(
        `SELECT r.receipt_id, r.action, r.object_type, r.object_id, r.decision, r.occurred_at,
                r.detail_json, r.invocation_id, i.caller_id
           FROM consent_receipt r
           LEFT JOIN agent_command_invocation i ON i.invocation_id = r.invocation_id
          WHERE r.action LIKE 'act %' OR r.action = 'reveal'
          ORDER BY r.receipt_id DESC LIMIT 500`
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
      caller_id: string | null;
    }[];
    const riskRank: Record<string, number> = { high: 2, medium: 1, low: 0 };
    const outboxGrantLookup = this.db.vault.prepare(
      "SELECT grant_id FROM outbox_item WHERE item_id = ?"
    );
    const entries = window.map((r) => {
      let risk: string | null = null;
      let context: ReviewEntry["context"] = null;
      let grantId: string | null = null;
      if (r.detail_json) {
        const detail = JSON.parse(r.detail_json) as {
          risk?: unknown;
          context?: unknown;
          output?: unknown;
          writes?: unknown;
        };
        if (typeof detail.risk === "string") risk = detail.risk;
        if (
          detail.context &&
          typeof detail.context === "object" &&
          (detail.context as { kind?: unknown }).kind === "fill" &&
          typeof (detail.context as { origin?: unknown }).origin === "string"
        ) {
          context = {
            kind: "fill",
            origin: (detail.context as { origin: string }).origin,
          };
        }
        const output =
          detail.output && typeof detail.output === "object"
            ? (detail.output as Record<string, unknown>)
            : null;
        if (
          output &&
          typeof output.grant_id === "string" &&
          output.grant_id.length > 0
        ) {
          grantId = output.grant_id;
        } else if (output && typeof output.item_id === "string") {
          const item = outboxGrantLookup.get(output.item_id) as
            | { grant_id: string | null }
            | undefined;
          if (item?.grant_id) grantId = item.grant_id;
        } else if (Array.isArray(detail.writes)) {
          for (const write of detail.writes) {
            if (
              write &&
              typeof write === "object" &&
              (write as { entityType?: unknown }).entityType ===
                "outbox.item" &&
              typeof (write as { entityId?: unknown }).entityId === "string"
            ) {
              const item = outboxGrantLookup.get(
                (write as { entityId: string }).entityId
              ) as { grant_id: string | null } | undefined;
              if (item?.grant_id) {
                grantId = item.grant_id;
                break;
              }
            }
          }
        }
      }
      const actorId = r.caller_id;
      const rawKind = actorId ? this.rawActorKind(actorId) : null;
      const actorKind =
        actorId && rawKind ? this.refineActorKind(actorId, rawKind) : null;
      const actor =
        actorId && rawKind ? this.actorName(actorId, rawKind) : null;
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
          actorId,
          actorKind,
          actor,
          grantId,
          context,
        } satisfies ReviewEntry,
        salience: (riskRank[risk ?? ""] ?? 0) + (r.decision === "deny" ? 1 : 0),
      };
    });
    return entries
      .sort(
        (a, b) =>
          b.salience - a.salience ||
          b.entry.occurredAt.localeCompare(a.entry.occurredAt)
      )
      .slice(0, Math.min(Math.max(limit, 1), 200))
      .map((e) => e.entry);
  }

  scopeSurface(appId: string): {
    scopes: Array<{
      plane: "app" | "agent";
      schema: string;
      table: string | null;
      verbs: string;
      rowFilter?: ScopeSpec["rowFilter"];
      fieldMask?: ScopeSpec["fieldMask"];
    }>;
    highlights: Array<{
      command: string;
      schema: string;
      risk: string;
      confirm: boolean;
    }>;
  } {
    const scopes: Array<{
      plane: "app" | "agent";
      schema: string;
      table: string | null;
      verbs: string;
      rowFilter?: ScopeSpec["rowFilter"];
      fieldMask?: ScopeSpec["fieldMask"];
    }> = [];
    const app = lookupAppByName(this.db, appId);
    if (app) {
      for (const grant of listActiveGrants(this.db, app.appId)) {
        for (const s of grant.scopes) {
          scopes.push({
            plane: "app",
            schema: s.schema,
            table: s.table,
            verbs: s.verbs,
            ...(s.rowFilter ? { rowFilter: s.rowFilter } : {}),
            ...(s.fieldMask ? { fieldMask: s.fieldMask } : {}),
          });
        }
      }
    }
    const agent = lookupAgentByName(this.db, appId);
    if (agent) {
      for (const grant of listActiveAgentGrants(this.db, agent.partyId)) {
        for (const s of grant.scopes) {
          scopes.push({
            plane: "agent",
            schema: s.schema,
            table: s.table,
            verbs: s.verbs,
            ...(s.rowFilter ? { rowFilter: s.rowFilter } : {}),
            ...(s.fieldMask ? { fieldMask: s.fieldMask } : {}),
          });
        }
      }
    }
    const actSchemas = [
      ...new Set(
        scopes.filter((s) => s.verbs.includes("act")).map((s) => s.schema)
      ),
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
                WHERE c.owner_schema IN (${actSchemas.map(() => "?").join(", ")})
                ORDER BY CASE c.risk WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, c.name`
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

  private refineActorKind(actorId: string, actorKind: string): string {
    if (actorKind !== "ai_agent") return actorKind;
    const row = this.db.vault
      .prepare("SELECT enrollment_key FROM consent_agent WHERE agent_id = ?")
      .get(actorId) as { enrollment_key: string } | undefined;
    return row?.enrollment_key === "_assistant" ? "assistant" : "agent";
  }

  private rawActorKind(actorId: string): string | null {
    const agent = this.db.vault
      .prepare("SELECT 1 AS x FROM consent_agent WHERE agent_id = ?")
      .get(actorId) as { x: number } | undefined;
    if (agent) return "ai_agent";
    const app = this.db.vault
      .prepare("SELECT 1 AS x FROM consent_app WHERE app_id = ?")
      .get(actorId) as { x: number } | undefined;
    if (app) return "app";
    const device = this.db.vault
      .prepare("SELECT 1 AS x FROM consent_device WHERE device_id = ?")
      .get(actorId) as { x: number } | undefined;
    if (device) return "owner";
    return null;
  }

  private actorName(actorId: string, actorKind: string): string | null {
    if (actorKind === "owner") return "owner";
    const row = this.db.vault
      .prepare(
        actorKind === "app"
          ? "SELECT COALESCE(display_name, name) AS name FROM consent_app WHERE app_id = ?"
          : `SELECT p.display_name AS name FROM consent_agent a
               JOIN core_party p ON p.party_id = a.party_id WHERE a.agent_id = ?`
      )
      .get(actorId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /**
   * THE ASSISTANT'S AUTHORITY, WRITTEN DOWN (#308). Writes ride an enrolled
   * `_assistant` agent, not the owner-device credential, so confirm-gated
   * commands park for the owner. `_assistant` holds a standing `act` grant
   * over EVERY command schema — more privileged than any installed app — and
   * that is intentional; the containment is that confirm-gated commands park,
   * it cannot decide the outbox or reveal sealed plaintext, and every act is
   * receipted under its own identity. The owner can narrow it durably: a
   * revoked grant tombstones its schemas and the self-heal skips them.
   */
  async invokeAsAssistant(request: InvokeRequest): Promise<InvokeOutcome> {
    const agent = ensureAgentEnrolled(this.db, "_assistant", {
      modelRef: "centraid-assistant",
      displayName: "Assistant",
    });
    // Self-healing: a later app's ext band joins with no re-enrollment.
    const schemas = this.db.vault
      .prepare(
        `SELECT DISTINCT owner_schema FROM agent_command ORDER BY owner_schema`
      )
      .all() as { owner_schema: string }[];
    const covered = new Set(
      (
        this.db.vault
          .prepare(
            `SELECT DISTINCT s.schema_name FROM consent_grant_scope s
               JOIN consent_access_grant g ON g.grant_id = s.grant_id
              WHERE g.grantee_party_id = ? AND g.status = 'active' AND g.revoked_at IS NULL`
          )
          .all(agent.partyId) as { schema_name: string }[]
      ).map((r) => r.schema_name)
    );
    // The owner's "no" binds the assistant too (#308 A4/B3).
    for (const t of listScopeTombstones(this.db, {
      granteePartyId: agent.partyId,
    })) {
      if (t.verbs === "act") covered.add(t.schema);
    }
    const missing = schemas.filter((s) => !covered.has(s.owner_schema));
    if (missing.length > 0) {
      const purpose = purposeConceptId(this.db, "dpv:ServiceProvision");
      if (!purpose)
        throw new Error("vault vocabulary missing dpv:ServiceProvision");
      createGrant(this.db, {
        granteePartyId: agent.partyId,
        purposeConceptId: purpose,
        grantedByPartyId: this.boot.ownerPartyId,
        scopes: missing.map((s) => ({
          schema: s.owner_schema,
          verbs: "act" as const,
        })),
      });
      this.logger.info(
        `vault plane: extended the _assistant standing act grant (+${missing.length} schema(s))`
      );
    }
    const cred: Credential = {
      kind: "agent",
      agentId: agent.agentId,
      deviceId: this.boot.deviceId,
      deviceKey: this.boot.deviceKey,
    };
    return this.invoke(cred, request);
  }

  /** OWNER-DEVICE credential: no grant keyhole applies. */
  sqlAsOwner(sql: string, maxRows?: number): VaultSqlResult {
    return this.gateway.sql(this.ownerCredential, {
      sql,
      ...(maxRows === undefined ? {} : { maxRows }),
      purpose: "owner-assistant",
    });
  }

  contentAsOwner(call: { contentId: string }): Promise<unknown> {
    return this.gateway.contentForAgent(this.ownerCredential, {
      contentId: call.contentId,
      variant: "text",
      purpose: "owner-assistant",
    });
  }

  assistantContext(): string {
    return buildAssistantContext(this.db);
  }

  resolveAsOwner(refs: { type: string; id: string }[]): ResolveResult {
    return this.gateway.resolveRefs(this.ownerCredential, {
      refs,
      purpose: "owner-assistant",
    });
  }

  sweep(): SweepResult {
    return this.gateway.sweep(this.ownerCredential);
  }

  applyAppExt(appId: string, tables: ExtTableSpec[]): ExtApplyOutcome {
    const outcome = this.gateway.applyAppExt(
      this.ownerCredential,
      appId,
      tables
    );
    if (
      outcome.created.length + outcome.dropped.length + outcome.altered.length >
      0
    ) {
      this.logger.info(
        `vault plane: ext band for "${appId}" — created [${outcome.created.join(", ")}] ` +
          `dropped [${outcome.dropped.join(", ")}] altered [${outcome.altered.join(", ")}]`
      );
    }
    return outcome;
  }

  seedAppExtDraft(appId: string, tables: ExtTableSpec[]): ExtApplyOutcome {
    return this.gateway.seedAppExtDraft(this.ownerCredential, appId, tables);
  }

  dropAppExtDraft(appId: string): { dropped: string[] } {
    return this.gateway.dropAppExtDraft(this.ownerCredential, appId);
  }

  purgeAppExt(appId: string): { purged: string[] } {
    const out = this.gateway.purgeAppExt(this.ownerCredential, appId);
    if (out.purged.length > 0) {
      this.logger.info(
        `vault plane: purged ext band for "${appId}" [${out.purged.join(", ")}]`
      );
    }
    return out;
  }

  invoke(cred: Credential, request: InvokeRequest): Promise<InvokeOutcome> {
    return this.groupCommitQueue.enqueue(() =>
      this.gateway.invoke(cred, request)
    );
  }

  private invokeQueued(
    cred: Credential,
    request: InvokeRequest
  ): Promise<VaultCallResult> {
    return asVaultCallResultAsync(() => this.invoke(cred, request));
  }

  /** Every write stamps `seed.demo` provenance: purgeable in one act,
   *  invisible to the automation plane (#290). */
  demoBridgeFor(appId: string): VaultBridge {
    return async (call): Promise<VaultCallResult> => {
      if (call.op === "invoke") {
        return this.invokeQueued(this.ownerCredential, {
          ...(call.payload as unknown as InvokeRequest),
          demo: { appId },
        });
      }
      return asVaultCallResult(() => {
        switch (call.op) {
          case "read":
            return this.gateway.read(
              this.ownerCredential,
              call.payload as unknown as ReadRequest
            );
          case "search":
            return this.gateway.search(
              this.ownerCredential,
              call.payload as unknown as SearchRequest
            );
          case "invoke":
            throw new Error("invoke is handled by the group-commit queue");
          case "describe":
            return this.gateway.discover(this.ownerCredential);
          case "query":
          case "parked":
          case "changes":
          case "resolve":
          case "reveal":
          case "authenticate":
          case "content":
            throw new GatewayError(
              "consent",
              `seed generators read and invoke — vault op ${call.op} is not part of the scenario surface`
            );
          default:
            throw new Error(`unsupported vault op ${call.op}`);
        }
      });
    };
  }

  purgeDemo(appId?: string): DemoPurgeResult {
    return this.gateway.purgeDemo(this.ownerCredential, appId);
  }

  demoStatus(): { appId: string; rows: number }[] {
    return this.gateway.demoStatus(this.ownerCredential);
  }

  /** Resolution happens PER CALL, so a revocation lands immediately. */
  bridgeFor(appId: string): VaultBridge {
    // Captured HERE, in the replica-intent async scope, so worker-message
    // scheduling cannot lose the binding.
    const replicaIntent = replicaIntentContext();
    const requestDeviceId = vaultContext()?.deviceKey;
    // An offline intent carries its own acting owner — the person who made the
    // write on the phone, not whoever's request replayed it (#599).
    const actingOwnerId = replicaIntent?.ownerId ?? vaultContext()?.ownerId;
    return async (call): Promise<VaultCallResult> => {
      const app = lookupAppByName(this.db, appId);
      if (!app) {
        return {
          ok: false,
          code: "VAULT_NOT_ENROLLED",
          error: `app "${appId}" is not enrolled in the vault`,
        };
      }
      const cred: Credential = {
        kind: "app",
        appId: app.appId,
        signingKey: app.signingKey,
      };
      if (call.op === "content") {
        return asVaultCallResultAsync(() =>
          this.gateway.contentForAgent(
            cred,
            call.payload as unknown as AgentContentRequest
          )
        );
      }
      if (call.op === "authenticate") {
        // MUST be awaited: `asVaultCallResult` takes `() => unknown`, so an
        // unawaited promise typechecks and reaches the app as an empty object
        // — a silent wrong answer on an AUTH path, with no compile error.
        if (appId !== "locker") {
          return asVaultCallResult(() => {
            throw new GatewayError(
              "identity",
              "Locker authentication is available only to Locker"
            );
          });
        }
        return asVaultCallResultAsync(() =>
          this.gateway.authenticateLocker(
            call.payload as unknown as LockerAuthRequest
          )
        );
      }
      if (call.op === "invoke") {
        return this.invokeQueued(cred, {
          ...withoutForgedIdentity(call.payload as unknown as InvokeRequest),
          ...(replicaIntent?.appId === appId
            ? {
                intentId: replicaIntent.intentId,
                intentDeviceId: replicaIntent.deviceId,
              }
            : requestDeviceId
              ? { intentDeviceId: requestDeviceId }
              : {}),
          ...(actingOwnerId === undefined ? {} : { actingOwnerId }),
        });
      }
      return asVaultCallResult(() => {
        switch (call.op) {
          case "read":
            return this.gateway.read(
              cred,
              call.payload as unknown as ReadRequest
            );
          case "search":
            return this.gateway.search(
              cred,
              call.payload as unknown as SearchRequest
            );
          case "invoke":
            throw new Error("invoke is handled by the group-commit queue");
          case "query":
            return this.gateway.queryView(
              cred,
              String(call.payload.view ?? ""),
              String(call.payload.purpose ?? ""),
              app.appId
            );
          case "describe":
            return this.gateway.discover(cred);
          case "parked":
            // Matched on `callerId`, NOT the display name.
            return this.gateway
              .listParked()
              .filter(
                (p) => p.callerKind === "app" && p.callerId === app.appId
              );
          case "resolve":
            return this.gateway.resolveRefs(
              cred,
              call.payload as unknown as RefRequest
            );
          case "reveal":
            // Locker lock/permit enforcement is data-keyed INSIDE
            // `gateway.reveal`, so fill, UI and agent arms share one gate.
            return this.gateway.reveal(
              cred,
              call.payload as unknown as RevealRequest
            );
          case "authenticate":
            throw new Error("authenticate is handled on the async path above");
          case "changes":
            throw new GatewayError(
              "consent",
              "the provenance feed is agent-plane — automations ride vault changes, apps do not"
            );
          case "content":
            throw new Error("content op is handled on the async path above");
          default:
            throw new Error(`unsupported vault op ${call.op}`);
        }
      });
    };
  }

  /** The agent-plane mirror of `bridgeFor`, resolving the credential per call
   *  so a revocation lands immediately. */
  agentBridgeFor(appId: string, block?: InstallScopeBlock): VaultBridge {
    // Absent for a scheduler-fired automation, which has no human behind it
    // to be capped at (#599).
    const scope = vaultContext();
    const onBehalfOfOwner =
      scope?.ownerId === undefined
        ? undefined
        : {
            ownerId: scope.ownerId,
            mayAct: scope.ownsVault === true,
          };
    return async (call): Promise<VaultCallResult> => {
      const agent = lookupAgentByName(this.db, appId);
      if (!agent) {
        return {
          ok: false,
          code: "VAULT_NOT_ENROLLED",
          error: `automation "${appId}" has no enrolled vault agent`,
        };
      }
      const cred: Credential = {
        kind: "agent",
        agentId: agent.agentId,
        deviceId: this.boot.deviceId,
        deviceKey: this.boot.deviceKey,
        ...(block
          ? {
              scopeClamp: block.scopes.map((scopeLocal) => ({
                schema: scopeLocal.schema,
                ...(scopeLocal.table === undefined
                  ? {}
                  : { table: scopeLocal.table }),
                verbs: scopeLocal.verbs,
                ...(scopeLocal.rowFilter
                  ? { rowFilter: [...scopeLocal.rowFilter] }
                  : {}),
                ...(scopeLocal.fieldMask
                  ? { fieldMask: [...scopeLocal.fieldMask] }
                  : {}),
              })),
            }
          : {}),
        ...(onBehalfOfOwner ? { onBehalfOfOwner } : {}),
      };
      if (call.op === "content") {
        // Visual originals are structurally refused; bounded AV originals are
        // the ONE exception, since ASR has no derivative rung (#299).
        return asVaultCallResultAsync(() =>
          this.gateway.contentForAgent(
            cred,
            call.payload as unknown as AgentContentRequest
          )
        );
      }
      if (call.op === "invoke") {
        return this.invokeQueued(cred, {
          ...withoutAgentIntent(
            withoutForgedIdentity(call.payload as unknown as InvokeRequest)
          ),
          ...(onBehalfOfOwner
            ? { actingOwnerId: onBehalfOfOwner.ownerId }
            : {}),
        });
      }
      return asVaultCallResult(() => {
        switch (call.op) {
          case "read":
            return this.gateway.read(
              cred,
              call.payload as unknown as ReadRequest
            );
          case "search":
            return this.gateway.search(
              cred,
              call.payload as unknown as SearchRequest
            );
          case "invoke":
            throw new Error("invoke is handled by the group-commit queue");
          case "describe":
            return this.gateway.discover(cred);
          case "parked":
            return this.gateway
              .listParked()
              .filter(
                (p) => p.callerKind === "agent" && p.callerId === agent.agentId
              );
          case "resolve":
            return this.gateway.resolveRefs(
              cred,
              call.payload as unknown as RefRequest
            );
          case "reveal":
            return this.gateway.reveal(
              cred,
              call.payload as unknown as RevealRequest
            );
          case "authenticate":
            throw new GatewayError(
              "consent",
              "Locker authentication is an interactive app surface"
            );
          case "changes":
            return this.gateway.changes(
              cred,
              call.payload as unknown as ChangesRequest
            );
          case "query":
            throw new GatewayError(
              "consent",
              "registered views belong to apps — automations read entities directly"
            );
          case "content":
            throw new Error("content op is handled on the async path above");
          default:
            throw new Error(`unsupported vault op ${call.op}`);
        }
      });
    };
  }

  static readonly FALLBACK_CHECKPOINT_WAL_BYTES = 64 * 1024 * 1024;

  /** The WAL COUNTS: those pages are the file's real occupancy. A missing
   *  file counts zero, so an unmeasurable journal reads as under any limit
   *  rather than archiving on a guess. */
  private journalFileBytes(): number {
    let total = 0;
    for (const name of ["journal.db", "journal.db-wal"]) {
      try {
        total += statSync(path.join(this.dir, name)).size;
      } catch {
        /* absent file — zero bytes, not an error */
      }
    }
    return total;
  }

  walTick(): void {
    if (this.closed) return;
    // A read-only registry may open the databases but must NEVER capture,
    // checkpoint, or mutate shipper state.
    if (!this.ownsWalLifecycle()) return;
    if (!this.walCaptureConfigured()) return;
    this.ensureWalShipper();
    if (!this.walShipper) {
      // `wal_autocheckpoint = 0` is set regardless, so without a checkpointer
      // the WALs grow unboundedly for the whole gateway uptime.
      try {
        const wal = path.join(this.dir, "vault.db-wal");
        const jwal = path.join(this.dir, "journal.db-wal");
        const oversized = (p: string) =>
          existsSync(p) &&
          statSync(p).size > VaultPlane.FALLBACK_CHECKPOINT_WAL_BYTES;
        if (oversized(wal) || oversized(jwal)) {
          this.gateway.checkpoint(this.ownerCredential);
          this.logger.warn(
            "vault plane: WAL checkpointed by fallback (no wal shipper — backups are NOT capturing this vault)"
          );
        }
      } catch (error) {
        this.logger.warn(
          `vault plane: fallback checkpoint failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return;
    }
    try {
      const report = this.walShipper.tick();
      for (const brk of report.breaks) {
        this.logger.warn(
          `vault plane: wal generation break (${brk.db}: ${brk.reason})`
        );
      }
      for (const err of report.errors) {
        this.logger.warn(
          `vault plane: wal capture error (${err.db}): ${err.message}`
        );
      }
    } catch (error) {
      this.logger.warn(
        `vault plane: wal tick failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private walCaptureDelayMs(): number {
    return (
      this.walTickOverrideMs ??
      readBackupPolicy(this.db.vault).rpoSeconds * 1000
    );
  }

  private setFallbackAutocheckpoint(enabled: boolean): void {
    for (const db of [this.db.vault, this.db.journal]) {
      const row = db.prepare("PRAGMA page_size").get() as
        | { page_size?: number }
        | undefined;
      const pageSize = row?.page_size ?? 8_192;
      const pages = enabled
        ? Math.max(
            1,
            Math.ceil(VaultPlane.FALLBACK_CHECKPOINT_WAL_BYTES / pageSize)
          )
        : 0;
      db.exec(`PRAGMA wal_autocheckpoint = ${pages}`);
    }
  }

  private scheduleWalCapture(): void {
    if (this.closed || !this.walLifecycleEnabled) return;
    if (!this.walCaptureConfigured()) {
      this.setFallbackAutocheckpoint(true);
      return;
    }
    this.walTimer = setTimeout(() => {
      this.walTimer = undefined;
      if (!this.walCaptureConfigured()) {
        this.setFallbackAutocheckpoint(true);
        return;
      }
      this.walTick();
      this.scheduleWalCapture();
    }, jitterDelayMs(this.walCaptureDelayMs()));
    this.walTimer.unref();
  }

  private scheduleSweep(): void {
    if (this.closed) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.runSweep();
      this.scheduleSweep();
    }, jitterDelayMs(this.sweepIntervalMs));
    this.sweepTimer.unref();
  }

  rescheduleWalCapture(): void {
    if (this.walTimer) clearTimeout(this.walTimer);
    if (this.firstWalTick) clearImmediate(this.firstWalTick);
    this.walTimer = undefined;
    this.firstWalTick = undefined;
    this.armWalCapture();
  }

  private armWalCapture(): void {
    if (this.closed || !this.walLifecycleEnabled) return;
    if (!this.walCaptureConfigured()) {
      this.setFallbackAutocheckpoint(true);
      return;
    }
    if (this.ownsWalLifecycle()) {
      this.ensureWalShipper();
      this.setFallbackAutocheckpoint(false);
      this.firstWalTick = setImmediate(() => {
        this.firstWalTick = undefined;
        this.walTick();
      });
      this.firstWalTick.unref();
    }
    this.scheduleWalCapture();
  }

  start(): void {
    // DEFERRED off the mount critical path: `start()` is awaited by boot and
    // nothing here is time-critical at second zero (#659).
    this.firstSweep = setImmediate(() => {
      this.firstSweep = undefined;
      if (!this.closed) this.runSweep();
    });
    this.firstSweep.unref();
    this.scheduleSweep();
    if (!this.walLifecycleEnabled) return;
    // Also deferred (#411): the first tick mints the generation base, which
    // is not advertised until it exists, so correctness is unaffected.
    this.armWalCapture();
  }

  private runSweep(): void {
    if (this.shouldDeferBackgroundWork()) return;
    const sweepStartedAt = Date.now();
    try {
      const result = this.sweep();
      const touched =
        result.grantsExpired +
        result.contentPurged +
        result.notesPurged +
        result.documentsPurged +
        result.domainRowsPurged +
        result.retentionDeleted +
        result.blobsReclaimed +
        result.stagingExpired;
      // The operator log and the journal receipt must tell the SAME story: a
      // sweep that declines purges touches nothing, and an operator would see
      // silence while the receipt records the refusal (#712).
      const blockedByLineage =
        result.assetsBlockedByLineage.length +
        result.contentBlockedByLineage.length;
      if (touched > 0 || blockedByLineage > 0) {
        this.logger.info(
          `vault plane: sweep grantsExpired=${result.grantsExpired} ` +
            `contentPurged=${result.contentPurged} notesPurged=${result.notesPurged} ` +
            `documentsPurged=${result.documentsPurged} domainRowsPurged=${result.domainRowsPurged} ` +
            `retentionDeleted=${result.retentionDeleted} ` +
            `blobsReclaimed=${result.blobsReclaimed} stagingExpired=${result.stagingExpired} ` +
            `assetsBlockedByLineage=${JSON.stringify(result.assetsBlockedByLineage)} ` +
            `contentBlockedByLineage=${JSON.stringify(result.contentBlockedByLineage)}`
        );
      }
      const replicaPrune = pruneReplicaChanges(this.db.vault);
      if (
        replicaPrune.expired +
          replicaPrune.compacted +
          replicaPrune.overflow +
          replicaPrune.discardedPriorEpochs >
        0
      ) {
        this.logger.info(
          `vault plane: replica prune expired=${replicaPrune.expired} ` +
            `compacted=${replicaPrune.compacted} overflow=${replicaPrune.overflow} ` +
            `priorEpochs=${replicaPrune.discardedPriorEpochs} retained=${replicaPrune.retained}`
        );
      }
      // DETACHED, so remote latency never blocks the sweep (#296). Backoff
      // (#367): one that keeps throwing would re-attempt every tick.
      const sweepStatus = this.db.blobs.sweepStatus();
      const backoff = blobSweepBackoff(sweepStatus, Date.now());
      if (backoff.skip) {
        this.logger.warn(
          `vault plane: blob sweep backing off after ${sweepStatus.consecutiveFailures} ` +
            `consecutive failure(s) — next attempt in ${Math.ceil(backoff.retryInMs / 1000)}s`
        );
      } else {
        this.runBlobSweep();
      }
      // Over an owner limit the daily gate is bypassed and the window narrows
      // a rung per sweep (#544).
      const archiveDecision = decideJournalArchive({
        journalBytes: this.journalFileBytes(),
        limitBytes: this.journalLimitBytes(),
        rung: this.journalArchiveRung,
        dailyGateElapsed:
          Date.now() - this.lastJournalArchivalAt >=
          JOURNAL_ARCHIVAL_MIN_INTERVAL_MS,
      });
      this.journalArchiveRung = archiveDecision.nextRung;
      if (archiveDecision.run) {
        this.lastJournalArchivalAt = Date.now();
        if (archiveDecision.overLimit) {
          this.logger.info(
            `vault plane: journal over its ${this.journalLimitBytes()}-byte limit — ` +
              `archiving early at a ${archiveDecision.windowDays}-day window` +
              (archiveDecision.atFloor ? " (window floor reached)" : "")
          );
        }
        const archiveWindow = { windowDays: archiveDecision.windowDays };
        try {
          // Ship BEFORE archival: the VACUUM rewrites the whole file through
          // the WAL, and the roll below absorbs it into a fresh base (#408).
          this.walTick();
          const archived = runJournalArchival(this.db, archiveWindow);
          if (archived.rowsArchived > 0) {
            this.logger.info(
              `vault plane: journal archival rowsArchived=${archived.rowsArchived} ` +
                `manifests=${archived.manifests.length} vacuum=${archived.reclaim.mode}`
            );
          }
          // Row-capped, so re-open the daily gate rather than looping: no
          // tick may block the event loop (#659).
          if (archived.capped) {
            this.lastJournalArchivalAt = 0;
            this.logger.info(
              "vault plane: journal archival hit its row cap — resuming next sweep"
            );
          }
          ensureConversationLedger(this.db.journal);
          // Runs BEFORE archival so live rows get honest costs first (#445).
          const repriced = repriceLedger(this.db.journal, {
            cursor: this.repriceCursor,
          });
          this.repriceCursor = repriced.nextCursor;
          if (repriced.itemsRepriced > 0) {
            this.logger.info(
              `vault plane: repriced items=${repriced.itemsRepriced} ` +
                `turns=${repriced.turnsRederived} scanned=${repriced.scanned}`
            );
          }
          const convArchival = runConversationArchival(
            {
              journal: this.db.journal,
              blobSink: {
                ingestSync: (bytes) => this.db.blobs.ingestSync(bytes),
                has: (sha) => this.db.blobs.hasSync(sha),
              },
              custodyProven: (sha) => blobCustodyProven(this.db, sha),
            },
            archiveWindow
          );
          if (
            convArchival.segmentsWritten > 0 ||
            convArchival.segmentsPruned > 0
          ) {
            this.logger.info(
              `vault plane: conversation archival segmentsWritten=${convArchival.segmentsWritten} ` +
                `turnsArchived=${convArchival.turnsArchived} segmentsPruned=${convArchival.segmentsPruned} ` +
                `turnsPruned=${convArchival.turnsPruned} vacuum=${convArchival.reclaim.mode}`
            );
          }
          // ONE shared roll if EITHER engine wrote: the vault+journal
          // generations must break TOGETHER, or a snapshot pairs a
          // post-archival journal base with a pre-archival vault base.
          if (
            archived.rowsArchived > 0 ||
            convArchival.segmentsWritten > 0 ||
            convArchival.segmentsPruned > 0
          ) {
            this.walShipper?.rollGeneration("journal", "journal-archival", {
              captureFirst: false,
            });
          }
        } catch (error) {
          this.logger.warn(
            `vault plane: journal archival failed: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // `vault.db` is the sovereign asset and must stay small (#659).
      const maintenanceDecision = decideVaultMaintenance({
        vaultBytes: vaultFileBytes(this.dir),
        limitBytes: this.vaultLimitBytes(),
        rung: this.vaultMaintenanceRung,
        dailyGateElapsed:
          Date.now() - this.lastVaultMaintenanceAt >=
          VAULT_MAINTENANCE_MIN_INTERVAL_MS,
      });
      this.vaultMaintenanceRung = maintenanceDecision.nextRung;
      if (maintenanceDecision.run) {
        this.lastVaultMaintenanceAt = Date.now();
        const maintained = runVaultMaintenance(this.db.vault, {
          now: new Date().toISOString(),
          keepDays: maintenanceDecision.keepDays,
        });
        const retained = Object.values(maintained.retention).reduce(
          (sum, table) => sum + table.deleted,
          0
        );
        if (maintained.revisions.deleted > 0 || retained > 0) {
          this.logger.info(
            `vault plane: vault maintenance revisions=${maintained.revisions.deleted} ` +
              `retention=${retained} keepDays=${maintained.keepDays}` +
              (maintenanceDecision.overLimit ? " (over limit)" : "")
          );
        }
        if (maintained.capped) this.lastVaultMaintenanceAt = 0;
      }
    } catch (error) {
      this.logger.warn(
        `vault plane: sweep failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      this.onSweepPass?.({ durationMs: Date.now() - sweepStartedAt });
    }
  }

  /** The orphan-DELETE phase pauses while a second gateway instance appears
   *  live against this vault root (#367). */
  private runBlobSweep(): void {
    const replicationStartedAt = Date.now();
    void Promise.all([
      this.resolveSnapshotBlobRoots(),
      this.resolveOrphanGraceWindowMs(),
    ])
      .then(async ([roots, graceWindowMs]) => {
        const skipOrphanDelete =
          this.skipOrphanDelete() || roots === "unavailable";
        const extraLiveRoots =
          roots !== "unavailable" && roots ? roots : undefined;
        const swept = await this.gateway.sweepBlobs(this.ownerCredential, {
          skipOrphanDelete,
          ...(extraLiveRoots ? { extraLiveRoots } : {}),
          ...(graceWindowMs === undefined ? {} : { graceWindowMs }),
        });
        this.runLocalOrphanSweep({
          skipOrphanDelete,
          extraLiveRoots,
          graceWindowMs,
        });
        return swept;
      })
      .then((blobs) => {
        if (
          blobs.replicated.length +
            blobs.orphansDeleted.length +
            blobs.orphansSkipped.length +
            blobs.orphansGraceHeld.length +
            blobs.missing.length >
          0
        ) {
          this.logger.info(
            `vault plane: blob sweep replicated=${blobs.replicated.length} ` +
              `orphansDeleted=${blobs.orphansDeleted.length} orphansSkipped=${blobs.orphansSkipped.length} ` +
              `orphansGraceHeld=${blobs.orphansGraceHeld.length} missing=${blobs.missing.length}`
          );
        }
        if (this.onReplicationPass) {
          let bytesReplicated = 0;
          for (const sha of blobs.replicated)
            bytesReplicated += this.db.blobs.statSync(sha)?.size ?? 0;
          this.onReplicationPass({
            bytesReplicated,
            durationMs: Date.now() - replicationStartedAt,
          });
        }
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `vault plane: blob sweep failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  /** Nothing else reclaims a local-only CAS entry (#599). It shares the
   *  remote phase's safety envelope and tombstone table, so the grace clock is
   *  ONE clock and an infinite window holds everything. */
  private runLocalOrphanSweep(options: {
    skipOrphanDelete: boolean;
    extraLiveRoots: ReadonlySet<string> | undefined;
    graceWindowMs: number | undefined;
  }): void {
    if (options.skipOrphanDelete) return;
    // Bounded slice + carried cursor, so per-tick cost is CONSTANT (#659).
    const result = sweepLocalOrphans(this.db, {
      graceWindowMs: options.graceWindowMs ?? LOCAL_ORPHAN_GRACE_MS,
      maxEntries: LOCAL_ORPHAN_SWEEP_MAX_ENTRIES,
      ...(this.localOrphanCursor === null
        ? {}
        : { cursor: this.localOrphanCursor }),
      ...(options.extraLiveRoots
        ? { extraLiveRoots: options.extraLiveRoots }
        : {}),
    });
    this.localOrphanCursor = result.nextCursor;
    if (result.deleted.length + result.graceHeld.length > 0) {
      this.logger.info(
        `vault plane: local orphan sweep reclaimed=${result.deleted.length} ` +
          `graceHeld=${result.graceHeld.length} examined=${result.examined}`
      );
    }
  }

  /** `'unavailable'` skips the orphan-DELETE phase entirely: a delete against
   *  an unknown reachability set could evict a byte a recovery-to-N still
   *  needs. Fail safe, NEVER fail open (#436). */
  private async resolveSnapshotBlobRoots(): Promise<
    ReadonlySet<string> | undefined | "unavailable"
  > {
    if (!this.snapshotBlobRoots) return undefined;
    try {
      return await this.snapshotBlobRoots();
    } catch (error) {
      this.logger.warn(
        `vault plane: retained-snapshot roots unavailable — skipping orphan delete to protect ` +
          `the recovery window (issue #436 §6): ${error instanceof Error ? error.message : String(error)}`
      );
      return "unavailable";
    }
  }

  /** A supplier that THROWS fails safe to an infinite grace: a window that
   *  SHOULD exist but could not be resolved must not license evicting an
   *  intra-interval recovery byte (#439). */
  private async resolveOrphanGraceWindowMs(): Promise<number | undefined> {
    if (!this.orphanGraceWindowMs) return undefined;
    try {
      return await this.orphanGraceWindowMs();
    } catch (error) {
      this.logger.warn(
        `vault plane: recovery window unavailable — holding all orphans (infinite grace) to protect ` +
          `the recovery window (issue #439 R4): ${error instanceof Error ? error.message : String(error)}`
      );
      return Number.POSITIVE_INFINITY;
    }
  }

  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.groupCommitQueue.flush();
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    if (this.firstSweep) clearImmediate(this.firstSweep);
    if (this.walTimer) clearTimeout(this.walTimer);
    if (this.firstWalTick) clearImmediate(this.firstWalTick);
    if (
      this.ownsWalLifecycle() &&
      this.walShipper &&
      this.walCaptureConfigured()
    ) {
      // The shipper is the ONLY checkpointer (#408 I2), so close without a
      // second optimize: SQLite would fold its WAL writes behind its back.
      try {
        this.walShipper.close();
      } catch (error) {
        this.logger.warn(
          `vault plane: wal shipper close failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      this.db.close({ skipOptimize: true });
      return;
    }
    if (this.ownsWalLifecycle() && this.walCaptureConfigured()) {
      try {
        this.gateway.checkpoint(this.ownerCredential);
      } catch (error) {
        this.logger.warn(
          `vault plane: checkpoint on stop failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    // An unconfigured owner relies on ordinary SQLite close-checkpointing: a
    // forced TRUNCATE here can block behind the memoized ledger handle.
    this.db.close({ skipOptimize: !this.ownsWalLifecycle() });
  }
}

export function openVaultPlane(options: VaultPlaneOptions): VaultPlane {
  return new VaultPlane(options);
}
