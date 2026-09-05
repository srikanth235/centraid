// governance: allow-repo-hygiene file-size-limit one cohesive plane (mount + both bridge planes + workspace accessors, #280; #282 adds anchorAsOwner, a one-line delegation like its link/unlink siblings); pending split of the bridge executors into a sibling module
/*
 * The vault plane (duality §12) — the gateway's mount of the owner's vault.
 *
 * The gateway process is the SOLE holder of the vault connection. Apps reach
 * it only through `ctx.vault`, and the running app is resolved to its enrolled
 * `access.app` credential HERE, host-side: no signing key ever crosses into a
 * handler worker. Consent, contracts, receipts and provenance are the vault
 * gateway's own pipeline; this module adds nothing and takes nothing away.
 */

import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  runConversationArchival,
  repriceLedger,
} from "@centraid/server/engine";
import type {
  RuntimeLogger,
  VaultBridge,
  VaultCall,
  VaultCallResult,
  VaultWorkspace,
} from "@centraid/server/engine";
import {
  AUTOMATION_ENTITY_SUBJECT,
  automationAnswers,
  automationSubjectsOf,
  hasAnsweredEver,
  scopeForSubject,
  listEgressAuthorities,
  liveEgressAuthorityIdsFor,
  buildAssistantContext,
  createGateway,
  nowIso,
  recordAutomationAnswers,
  revokeAutomationAnswers,
  ensureAgentEnrolled,
  ensureAppEnrolled,
  bootstrapVault,
  recoverVaultBootstrap,
  GatewayError,
  listEnrolledAgents,
  listEnrolledApps,
  listInstalledApps,
  setAppLabel,
  lookupAgentByName,
  lookupAppByName,
  markAgentRevoked,
  markAppRevoked,
  openVaultDb,
  checkpointVault,
  deleteReplicaIntentOutcomesForDevice,
  closeObsoleteScopeRequest,
  getOpenScopeRequest,
  listOpenScopeRequests,
  markScopeRequestDecided,
  openScopeRequest,
  renameVault,
  readVaultPresentation,
  readVaultPersonal,
  markVaultPersonal,
  readBackupPolicy,
  updateVaultPresentation,
  registerAttachmentCommands,
  registerTagCommands,
  registerDocumentCommands,
  registerEnrichCommands,
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
  registerShareCommands,
  registerSyncCommands,
  registerTallyCommands,
  registerTaskCommands,
  registerAtlasCommands,
  pruneReplicaChanges,
  runJournalArchival,
  blobCustodyProven,
  WalShipper,
  jitterDelayMs,
  sweepLocalOrphans,
  decideVaultMaintenance,
  runVaultMaintenance,
  vaultFileBytes,
} from "@centraid/vault";
import type {
  AutomationAnswer,
  AutomationSubject,
  VaultFootprintBudget,
  InstalledAppRow,
  ScopeRequestSummary,
  VaultPresentation,
  AgentSummary,
  AppSummary,
  ChangesRequest,
  Credential,
  Gateway as VaultGateway,
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
import { unrefTimer } from "../lib/unref-timer.js";
import {
  declaredManifestFor,
  recordDeclaredManifest,
} from "../routes/replica-declared-scopes.js";
import { GroupCommitQueue, groupCommitWindowMs } from "./group-commit-queue.js";
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
import { createReadCoalescer } from "./vault-read-coalescer.js";
import type { SyncVaultRead } from "./vault-read-coalescer.js";

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
  /** The host's measured 4 KiB fsync, from the boot probe: it sizes the
   *  group-commit window, which exists to share exactly one of them. */
  storageFsyncMs?: number;
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
  scopes: ScopeSpec[];
}

export interface InstallScopeBlock {
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
  /** The standing answer that auto-allowed this receipt (#552, #928) — one
   *  id space: every value here is a `share_authority.authority_id`. */
  authorityId: string | null;
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
 * The subjects a published manifest asks for that the owner has NOT answered
 * either way (#928 A3). A `declined` row is an answer and is therefore not
 * "missing" — re-asking on every mount is what #308 called the top-up steering
 * itself, and the one plane keeps refusals as rows so it cannot.
 */
function unansweredSubjects(
  held: readonly AutomationAnswer[],
  declared: InstallScopeBlock["scopes"]
): AutomationSubject[] {
  const answered = new Set(
    held.map(
      (answer) => `${answer.subjectType} ${answer.subjectId} ${answer.verb}`
    )
  );
  return automationSubjectsOf(
    declared.map((scope) => ({
      schema: scope.schema,
      ...(scope.table === undefined ? {} : { table: scope.table }),
      verbs: scope.verbs,
    }))
  ).filter(
    (subject) =>
      !answered.has(
        `${subject.subjectType} ${subject.subjectId} ${subject.verb}`
      )
  );
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

/** The one agent that holds no standing answer at all (#928 A3). */
const ASSISTANT_ENROLLMENT_KEY = "_assistant";

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
  /** One durable commit per tool batch on the agent plane (#922 B.1). */
  private readonly coalesceAgentRead: (
    run: SyncVaultRead
  ) => Promise<VaultCallResult>;
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
  private sweepTimer: ReturnType<typeof setTimeout> | undefined;
  private firstSweep: ReturnType<typeof setImmediate> | undefined;
  private walTimer: ReturnType<typeof setTimeout> | undefined;
  private firstWalTick: ReturnType<typeof setImmediate> | undefined;
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
      groupCommitWindowMs(options.storageFsyncMs),
      (runs) => this.gateway.invokeBatchSettled(runs)
    );
    this.coalesceAgentRead = createReadCoalescer(this.gateway);
    registerScheduleCommands(this.gateway);
    registerTaskCommands(this.gateway);
    registerSocialCommands(this.gateway);
    registerKnowledgeCommands(this.gateway);
    registerAttachmentCommands(this.gateway);
    registerTagCommands(this.gateway);
    registerLinkCommands(this.gateway);
    registerPartyCommands(this.gateway);
    registerMediaCommands(this.gateway);
    registerMediaGazetteerCommands(this.gateway);
    registerDocumentCommands(this.gateway);
    registerPeopleCommands(this.gateway);
    registerLockerCommands(this.gateway);
    registerTallyCommands(this.gateway);
    registerSyncCommands(this.gateway);
    registerEnrichCommands(this.gateway);
    registerOutboxCommands(this.gateway);
    registerShareCommands(this.gateway);
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
      journal: () => this.ledger(),
      ledgerDbFile: path.join(this.dir, "vault.db"),
      harnessSessionDir: path.join(this.cacheDir, "harness-sessions"),
    };
  }

  get codeStoreRoot(): string {
    return path.join(this.dir, "code");
  }

  /** The ledger band of the one file (#916) — the same handle every other
   *  band is served from; the vault composes the band when it opens. */
  private ledger(): DatabaseSync {
    if (this.closed)
      throw new Error(`vault plane ${this.boot.vaultId} is stopped`);
    return this.db.vault;
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
    const enrolled = ensureAppEnrolled(this.db, appId);
    if (enrolled.created)
      this.logger.info(`vault plane: enrolled app "${appId}"`);
  }

  /** Identity ONLY: declared scopes are granted by the install-time grant
   *  path (#434). */
  installApp(appId: string, displayName?: string): { created: boolean } {
    const enrolled = ensureAppEnrolled(
      this.db,
      appId,
      displayName ? { displayName } : {}
    );
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
      (request) => request.principalId === appId
    );
    let revoked = 0;
    const app = lookupAppByName(this.db, appId);
    if (app) {
      // The band goes with the INSTALL now, not with a grant: a first-party
      // app holds no standing answer to lose (#928 A1), so uninstall is the
      // moment its own tables stop being live.
      const { retained } = this.gateway.retainAppExt(
        this.ownerCredential,
        appId
      );
      if (retained.length > 0)
        this.logger.info(
          `vault plane: retained ext tables for "${appId}" (${retained.join(", ")})`
        );
      markAppRevoked(this.db, app.appId);
    }
    const agent = lookupAgentByName(this.db, appId);
    if (agent) {
      for (const answer of automationAnswers(this.db.vault, appId)) {
        this.gateway.revokeAuthority(this.ownerCredential, answer.authorityId);
        revoked += 1;
      }
      // Uninstall WIPES the memory (#306): the rows stay as evidence, stamped
      // `principal-removed`, and a reinstall answers itself afresh.
      revokeAutomationAnswers(this.db.vault, appId, nowIso());
      markAgentRevoked(this.db, agent.agentId);
      this.logger.info(
        `vault plane: withdrew ${revoked} standing answer(s) for "${appId}"`
      );
    }
    // Standing answers die WITH the actor (#306).
    const outboxRevocations: string[] = [];
    for (const actorId of [app?.appId, agent?.agentId]) {
      if (!actorId) continue;
      for (const authorityId of liveEgressAuthorityIdsFor(
        this.db.vault,
        actorId
      )) {
        outboxRevocations.push(authorityId);
      }
    }
    const revokeResults = this.gateway.invokeBatchSettled(
      outboxRevocations.map(
        (authorityId) => () =>
          this.gateway.invoke(this.ownerCredential, {
            command: "outbox.revoke_grant",
            input: { authority_id: authorityId },
          })
      )
    );
    for (const [index, result] of revokeResults.entries()) {
      if (!result.ok) throw result.error;
      const revokedAuthorityId = outboxRevocations[index]!;
      this.logger.info(
        `vault plane: revoked standing egress answer ${revokedAuthorityId} for "${appId}"`
      );
    }
    closeObsoleteScopeRequest(this.db, appId);
    if (hadOpenScopeRequest) this.ringNotificationsChanged(false);
    return { grantsRevoked: revoked };
  }

  /**
   * The owner's YES about an automation, in the one plane (#928 A3). This is
   * the one path both the install-time approval and the owner's decision on a
   * parked widening run through — a manifest that only PARKS reaches
   * `openScopeRequest` instead and mints nothing, which is what keeps a
   * widened manifest parked rather than silently answered.
   *
   * Without `displayName` a first-touch automation is stuck with a bare
   * `humanizeSlug(appId)` until a later reconcile.
   */
  approveAgentGrant(
    appId: string,
    request: GrantRequest,
    displayName?: string
  ): number {
    // THE ASSISTANT HOLDS NO STANDING ANSWER (#928 A3). It is the owner's own
    // voice, so its reach is the acting owner's and is never a row — refused
    // here rather than filtered later, so no path can mint one by accident.
    if (appId === ASSISTANT_ENROLLMENT_KEY) return 0;
    ensureAgentEnrolled(this.db, appId, {
      modelRef: "centraid-automation",
      ...(displayName ? { displayName } : {}),
    });
    if (request.scopes.length === 0)
      throw new Error("an answer needs at least one scope");
    return recordAutomationAnswers(this.db.vault, {
      principalId: appId,
      ownerPartyId: this.boot.ownerPartyId,
      subjects: automationSubjectsOf(request.scopes),
      decision: "granted",
      now: nowIso(),
    });
  }

  /**
   * INSTALLING IS NOT A GRANT (#928 A1). A first-party app is not a principal:
   * what an install records is the app's own build-time declaration, which is
   * what a replica shape is composed from and what the static entity tripwire
   * holds it to. No grant is minted, nothing parks, and an owner-device read
   * of the owner's vault runs no authority statement at all.
   */
  recordAppInstall(appId: string, block: InstallScopeBlock): void {
    ensureAppEnrolled(this.db, appId);
    recordDeclaredManifest(this.db.vault, appId, {
      scopes: block.scopes.map((scope) => ({
        schema: scope.schema,
        ...(scope.table === undefined ? {} : { table: scope.table }),
        verbs: scope.verbs,
        // The declared row filter and field mask STAY (#928, deviating from
        // A1's "minus filters and masks"): they are build-time properties of
        // the app's own code, not grants, and they are what keeps a replica
        // holding one entity type's revisions instead of every app's.
        ...(scope.rowFilter ? { rowFilter: [...scope.rowFilter] } : {}),
        ...(scope.fieldMask ? { fieldMask: [...scope.fieldMask] } : {}),
      })),
    });
  }

  ensureAgentInstallGrant(appId: string, block: InstallScopeBlock): void {
    if (appId === ASSISTANT_ENROLLMENT_KEY) return;
    ensureAgentEnrolled(this.db, appId, { modelRef: "centraid-automation" });
    const held = automationAnswers(this.db.vault, appId);
    const existingRequest = this.listScopeRequests().find(
      (request) => request.principalId === appId
    );
    const missing = unansweredSubjects(held, block.scopes);
    if (missing.length === 0) {
      closeObsoleteScopeRequest(this.db, appId);
      if (existingRequest) this.ringNotificationsChanged(false);
      return;
    }
    // Install WAS the answer, for what was declared AT install. Afterwards a
    // widening PARKS, and so does a subject the owner WITHDREW: automations
    // author their own manifests, so a re-publish must not steer its own
    // containment, and a withdrawal must not be undone by the next mount
    // (#306, #308 A4). "Never asked" is the only case that answers itself.
    if (!hasAnsweredEver(this.db.vault, appId)) {
      this.approveAgentGrant(appId, { scopes: [...block.scopes] });
      this.logger.info(
        `vault plane: install-time answer for automation "${appId}" (+${missing.length} subject(s))`
      );
      return;
    }
    // The ask carries EXACTLY the unanswered subjects, never the whole
    // manifest: deciding it must not re-answer what the owner already settled,
    // and a "no" to a widening must not withdraw the yes it already gave.
    const nextScopes = missing.map((subject) => scopeForSubject(subject));
    openScopeRequest(this.db, { principalId: appId, scopes: nextScopes });
    if (
      !existingRequest ||
      JSON.stringify(existingRequest.scopes) !== JSON.stringify(nextScopes)
    ) {
      this.ringNotificationsChanged(existingRequest === undefined);
    }
    this.logger.info(
      `vault plane: automation "${appId}" asks for ${missing.length} subject(s) beyond its last answer — parked for the owner`
    );
  }

  listScopeRequests(): ScopeRequestSummary[] {
    return listOpenScopeRequests(this.db);
  }

  decideScopeRequest(requestId: string, approve: boolean): ScopeRequestSummary {
    const request = getOpenScopeRequest(this.db, requestId);
    if (!request) throw new Error(`no open scope request ${requestId}`);
    if (approve) {
      this.approveAgentGrant(request.principalId, {
        scopes: request.scopes.map((s) => ({
          schema: s.schema,
          ...(s.table === undefined ? {} : { table: s.table }),
          verbs: s.verbs,
        })),
      });
    } else {
      // A refusal is an ANSWER (#883 V-table): without the row, the next
      // compile cannot tell "told no" from "never asked" and re-asks.
      ensureAgentEnrolled(this.db, request.principalId, {
        modelRef: "centraid-automation",
      });
      recordAutomationAnswers(this.db.vault, {
        principalId: request.principalId,
        ownerPartyId: this.boot.ownerPartyId,
        subjects: automationSubjectsOf(
          request.scopes.map((s) => ({
            schema: s.schema,
            ...(s.table === undefined ? {} : { table: s.table }),
            verbs: s.verbs,
          }))
        ),
        decision: "declined",
        now: nowIso(),
      });
    }
    markScopeRequestDecided(
      this.db,
      requestId,
      approve ? "approved" : "denied"
    );
    this.ringNotificationsChanged(false);
    this.logger.info(
      `vault plane: owner ${approve ? "approved" : "denied"} the automation "${request.principalId}" scope request (${request.scopes.length} scope(s))`
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

  /**
   * The install register, each row carrying the app's own DECLARED manifest
   * (#928 A1) — what it reaches, which is not a grant and cannot be revoked.
   * An app the mount pass has not declared for reaches nothing, and says so
   * with an empty scope list rather than an absent field.
   */
  listApps(): Array<AppSummary & { scopes: ScopeSpec[] }> {
    return listEnrolledApps(this.db).map((app) => ({
      ...app,
      scopes: [...(declaredManifestFor(this.db.vault, app.name)?.scopes ?? [])],
    }));
  }

  listAgents(): Array<AgentSummary & { answers: AutomationAnswer[] }> {
    const answers = automationAnswers(this.db.vault);
    return listEnrolledAgents(this.db).map((agent) => ({
      ...agent,
      // The standing answer the Approvals surfaces read (#928 A3), keyed by
      // the automation's own id rather than by its agent party.
      answers: answers.filter(
        (answer) => answer.principalId === agent.enrollmentKey
      ),
    }));
  }

  revokeAuthority(authorityId: string): RevocationResult {
    return this.gateway.revokeAuthority(this.ownerCredential, authorityId);
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
    });
  }

  unlinkAsOwner(linkId: string): Promise<InvokeOutcome> {
    return this.invoke(this.ownerCredential, {
      command: "core.unlink_entities",
      input: { link_id: linkId },
    });
  }

  anchorAsOwner(
    linkId: string,
    selector: AnchorSelector | null
  ): Promise<InvokeOutcome> {
    return this.invoke(this.ownerCredential, {
      command: "core.anchor_link",
      input: { link_id: linkId, ...(selector ? { selector } : {}) },
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
                i.status, i.authority_id, i.staged_at, i.decided_at, i.drained_at, i.result_json,
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
      authority_id: string | null;
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
      grantId: r.authority_id,
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
    return listEgressAuthorities(this.db.vault).map((row) => ({
      grantId: row.authorityId,
      actor:
        this.actorName(row.actorId, "ai_agent") ??
        this.actorName(row.actorId, "app"),
      actorId: row.actorId,
      verb: row.verb,
      target: row.target,
      createdAt: row.grantedAt,
      revokedAt: row.revokedAt,
    }));
  }

  revokeOutboxGrant(authorityId: string): Promise<InvokeOutcome> {
    return this.invoke(this.ownerCredential, {
      command: "outbox.revoke_grant",
      input: { authority_id: authorityId },
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
    const window = this.db.audit
      .prepare(
        `SELECT r.receipt_id, r.action, r.object_type, r.object_id, r.decision, r.occurred_at,
                r.detail_json, r.invocation_id, i.caller_id
           FROM access_receipt r
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
    const outboxAuthorityLookup = this.db.vault.prepare(
      "SELECT authority_id FROM outbox_item WHERE item_id = ?"
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
          typeof output.authority_id === "string" &&
          output.authority_id.length > 0
        ) {
          grantId = output.authority_id;
        } else if (output && typeof output.item_id === "string") {
          const item = outboxAuthorityLookup.get(output.item_id) as
            | { authority_id: string | null }
            | undefined;
          if (item?.authority_id) grantId = item.authority_id;
        } else if (Array.isArray(detail.writes)) {
          for (const write of detail.writes) {
            if (
              write &&
              typeof write === "object" &&
              (write as { entityType?: unknown }).entityType ===
                "outbox.item" &&
              typeof (write as { entityId?: unknown }).entityId === "string"
            ) {
              const item = outboxAuthorityLookup.get(
                (write as { entityId: string }).entityId
              ) as { authority_id: string | null } | undefined;
              if (item?.authority_id) {
                grantId = item.authority_id;
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
          authorityId: grantId,
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

  /**
   * What this app or automation reaches, and the loud commands that reach
   * comes with. TWO DIFFERENT FACTS since #928: an app's reach is what it
   * DECLARED at build time (its manifest, held by the install path), an
   * automation's is what the owner ANSWERED (`share_authority` rows). Neither
   * is a grant, and the surface says which it is.
   */
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
    for (const scope of declaredManifestFor(this.db.vault, appId)?.scopes ??
      []) {
      scopes.push({
        plane: "app",
        schema: scope.schema,
        table: scope.table ?? null,
        verbs: scope.verbs,
        ...(scope.rowFilter ? { rowFilter: scope.rowFilter } : {}),
        ...(scope.fieldMask ? { fieldMask: scope.fieldMask } : {}),
      });
    }
    for (const answer of automationAnswers(this.db.vault, appId)) {
      if (answer.decision !== "granted") continue;
      const dot = answer.subjectId.indexOf(".");
      const entity = answer.subjectType === AUTOMATION_ENTITY_SUBJECT;
      scopes.push({
        plane: "agent",
        schema: entity ? answer.subjectId.slice(0, dot) : answer.subjectId,
        table: entity ? answer.subjectId.slice(dot + 1) : null,
        verbs: answer.verb,
      });
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
      .prepare("SELECT enrollment_key FROM access_agent WHERE agent_id = ?")
      .get(actorId) as { enrollment_key: string } | undefined;
    return row?.enrollment_key === ASSISTANT_ENROLLMENT_KEY
      ? "assistant"
      : "agent";
  }

  private rawActorKind(actorId: string): string | null {
    const agent = this.db.vault
      .prepare("SELECT 1 AS x FROM access_agent WHERE agent_id = ?")
      .get(actorId) as { x: number } | undefined;
    if (agent) return "ai_agent";
    const app = this.db.vault
      .prepare("SELECT 1 AS x FROM access_app WHERE app_id = ?")
      .get(actorId) as { x: number } | undefined;
    if (app) return "app";
    const device = this.db.vault
      .prepare("SELECT 1 AS x FROM access_device WHERE device_id = ?")
      .get(actorId) as { x: number } | undefined;
    if (device) return "owner";
    return null;
  }

  private actorName(actorId: string, actorKind: string): string | null {
    if (actorKind === "owner") return "owner";
    const row = this.db.vault
      .prepare(
        actorKind === "app"
          ? "SELECT COALESCE(display_name, name) AS name FROM access_app WHERE app_id = ?"
          : `SELECT p.display_name AS name FROM access_agent a
               JOIN core_party p ON p.party_id = a.party_id WHERE a.agent_id = ?`
      )
      .get(actorId) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /**
   * THE ASSISTANT HOLDS NO STANDING ANSWER (#928 A3). Writes ride the enrolled
   * `_assistant` agent, not the owner-device credential, so confirm-gated
   * commands still park for the owner and every act is receipted under its own
   * identity — but its REACH is the acting owner's, carried on the on-behalf-of
   * identity and capped by that owner's trust tier. With no acting owner behind
   * the call there is nothing to ride and the gateway refuses.
   */
  async invokeAsAssistant(request: InvokeRequest): Promise<InvokeOutcome> {
    const agent = ensureAgentEnrolled(this.db, ASSISTANT_ENROLLMENT_KEY, {
      modelRef: "centraid-assistant",
      displayName: "Assistant",
    });
    const scope = vaultContext();
    const cred: Credential = {
      kind: "agent",
      agentId: agent.agentId,
      deviceId: this.boot.deviceId,
      deviceKey: this.boot.deviceKey,
      ...(scope?.ownerId === undefined
        ? {}
        : {
            onBehalfOfOwner: {
              ownerId: scope.ownerId,
              mayAct: scope.ownsVault === true,
            },
          }),
    };
    return this.invoke(cred, request);
  }

  /**
   * Whole-model SQL is the OWNER'S surface, and the assistant only ever holds
   * it on the owner's behalf (#928 A3). The acting owner is checked here rather
   * than assumed: with nobody behind the call — a scheduler-fired run — there is
   * no authority to exercise. `gateway.sql` receipts both the allow and the
   * refusal, so the exercise is evidence either way.
   */
  sqlAsAssistant(sql: string, maxRows?: number): VaultSqlResult {
    const scope = vaultContext();
    if (scope?.ownsVault !== true) {
      throw new GatewayError(
        "access",
        "whole-model sql is the owner's surface — the assistant holds it only on an acting owner's behalf"
      );
    }
    return this.gateway.sql(this.ownerCredential, {
      sql,
      ...(maxRows === undefined ? {} : { maxRows }),
    });
  }

  contentAsOwner(call: { contentId: string }): Promise<unknown> {
    return this.gateway.contentForAgent(this.ownerCredential, {
      contentId: call.contentId,
      variant: "text",
    });
  }

  assistantContext(): string {
    return buildAssistantContext(this.db);
  }

  resolveAsOwner(refs: { type: string; id: string }[]): ResolveResult {
    return this.gateway.resolveRefs(this.ownerCredential, {
      refs,
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
          case "parked":
          case "changes":
          case "resolve":
          case "reveal":
          case "authenticate":
          case "content":
            throw new GatewayError(
              "access",
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

  /**
   * The host attaches WHEN the app was retired: `access_app.status` going
   * `revoked` is what put a call here, and the app cannot read that register.
   * Absent while the app is still installed — a refusal that was never an
   * uninstall carries no time, and no caller may invent one.
   */
  private withRevocationTime(
    appId: string,
    result: VaultCallResult
  ): VaultCallResult {
    if (result.ok || result.code !== "VAULT_ACCESS") return result;
    const row = this.db.vault
      .prepare(
        `SELECT revoked_at FROM access_app
          WHERE name = ? AND revoked_at IS NOT NULL
          ORDER BY revoked_at DESC LIMIT 1`
      )
      .get(appId) as { revoked_at: string } | undefined;
    return row ? { ...result, revokedAt: row.revoked_at } : result;
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
    const serve = async (call: VaultCall): Promise<VaultCallResult> => {
      const app = lookupAppByName(this.db, appId);
      if (!app) {
        return {
          ok: false,
          code: "VAULT_NOT_ENROLLED",
          error: `app "${appId}" is not enrolled in the vault`,
        };
      }
      // ATTRIBUTION, NOT AUTHORITY (#928 A1): a first-party app is not a
      // principal. It runs on the owner's own device against the owner's own
      // vault and NAMES itself, so every receipt and provenance row still says
      // which surface carried the call; its reach is fixed at build time by
      // its declared entity manifest and the static tripwire over it.
      const declared = declaredManifestFor(this.db.vault, appId);
      const cred: Credential = {
        kind: "device",
        deviceId: this.boot.deviceId,
        deviceKey: this.boot.deviceKey,
        surface: app.appId,
        // The app's own build-time manifest, enforced per call as an
        // attenuation. It only ever narrows, it is what keeps this read and
        // the app's replica rows the same rows with the same columns, and an
        // app this vault has NO declaration for gets the empty clamp — which
        // reaches nothing. Fail-closed: being enrolled is not being declared.
        scopeClamp: declared?.scopes ?? [],
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
              "access",
              "the provenance feed is agent-plane — automations ride vault changes, apps do not"
            );
          case "content":
            throw new Error("content op is handled on the async path above");
          default:
            throw new Error(`unsupported vault op ${call.op}`);
        }
      });
    };
    return async (call) => this.withRevocationTime(appId, await serve(call));
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
      // ONE DURABLE COMMIT PER TOOL BATCH (#922 B.1): the reads a model turn
      // issues together settle in one commit, and the commit is inside a
      // single synchronous drain, so no model turn is ever inside the write
      // lock and no receipt outlives its own reply.
      return this.coalesceAgentRead(() =>
        asVaultCallResult(() => {
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
                  (p) =>
                    p.callerKind === "agent" && p.callerId === agent.agentId
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
                "access",
                "Locker authentication is an interactive app surface"
              );
            case "changes":
              return this.gateway.changes(
                cred,
                call.payload as unknown as ChangesRequest
              );
            case "content":
              throw new Error("content op is handled on the async path above");
            default:
              throw new Error(`unsupported vault op ${call.op}`);
          }
        })
      );
    };
  }

  static readonly FALLBACK_CHECKPOINT_WAL_BYTES = 64 * 1024 * 1024;

  walTick(): void {
    if (this.closed) return;
    // A read-only registry may open the databases but must NEVER capture,
    // checkpoint, or mutate shipper state.
    if (!this.ownsWalLifecycle()) return;
    if (!this.walCaptureConfigured()) return;
    this.ensureWalShipper();
    if (!this.walShipper) {
      // `wal_autocheckpoint = 0` is set regardless, so without a checkpointer
      // the WALs grow unboundedly for the whole gateway uptime. The size test
      // and the reader-safe checkpoint both live in the vault (#922 B6).
      try {
        const pass = this.db.checkpointIfLargerThan(
          VaultPlane.FALLBACK_CHECKPOINT_WAL_BYTES
        );
        if (pass.checkpointed) {
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
        this.logger.warn(`vault plane: wal generation break (${brk.reason})`);
      }
      for (const err of report.errors) {
        this.logger.warn(`vault plane: wal capture error: ${err.message}`);
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
    for (const db of [this.db.vault, this.db.audit]) {
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
    unrefTimer(this.walTimer);
  }

  private scheduleSweep(): void {
    if (this.closed) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.runSweep();
      this.scheduleSweep();
    }, jitterDelayMs(this.sweepIntervalMs));
    unrefTimer(this.sweepTimer);
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
      unrefTimer(this.firstWalTick);
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
    unrefTimer(this.firstSweep);
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
        result.authorityRevoked +
        result.contentPurged +
        result.notesPurged +
        result.documentsPurged +
        result.domainRowsPurged +
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
          `vault plane: sweep authorityRevoked=${result.authorityRevoked} ` +
            `contentPurged=${result.contentPurged} notesPurged=${result.notesPurged} ` +
            `documentsPurged=${result.documentsPurged} domainRowsPurged=${result.domainRowsPurged} ` +
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
        journalBytes: vaultFileBytes(this.dir),
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
          // Runs BEFORE archival so live rows get honest costs first (#445).
          const repriced = repriceLedger(this.db.vault, {
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
              journal: this.db.vault,
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
          // Both engines rewrite the one file through the WAL, so a roll
          // absorbs the VACUUM into a fresh base (#408).
          if (
            archived.rowsArchived > 0 ||
            convArchival.segmentsWritten > 0 ||
            convArchival.segmentsPruned > 0
          ) {
            this.walShipper?.rollGeneration("journal-archival", {
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
