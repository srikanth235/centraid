// governance: allow-repo-hygiene file-size-limit (#408) one serialized run-chain contract — backup, verify, restore-verify and the wal drain share one state row, fencing and keyring

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  BackupProviderError,
  createSnapshot,
  openLocalBackupProvider,
  openManifest,
  openRemoteBackupProvider,
  parseRecoveryKit,
  restoreSnapshot,
  recoveryKitFingerprint,
  wrapRecoveryKit,
  verifySnapshot,
  validateKeyring,
} from "@centraid/backup";
import type {
  BackupProvider,
  Keyring,
  RecoveryKitDocument,
  Retention,
  RestoreResult,
  SnapshotRow,
  SourceEntry,
  VerifySnapshotResult,
} from "@centraid/backup";
import type { RuntimeLogger } from "@centraid/server/engine";
import {
  DEFAULT_BACKUP_POLICY,
  MIN_RPO_SECONDS,
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
  bumpReplicaEpoch,
  jitterDelayMs,
  readBackupPolicy,
  readBlobStoreSettings,
  KeyStore,
  sealKeyFileFor,
  verifyRestoredPair,
} from "@centraid/vault";
import type { BackupPolicy, RemoteTier } from "@centraid/vault";

import { unrefTimer } from "../lib/unref-timer.js";
import { GatewayDatabase } from "../serve/gateway-db.js";
import type { HealthRegistry } from "../serve/health-registry.js";
import type { VaultPlane } from "../serve/vault-plane.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { GATEWAY_VERSION } from "../version.js";
import { resolveBackupBackend } from "./backup-backend.js";
import {
  failedCasOnlyReconciliation,
  runCasOnlyReconciliation,
} from "./backup-cas-reconciliation.js";
import type { BackupConfig, BackupProviderConfig } from "./backup-config.js";
import { evaluateBackupHealth } from "./backup-health.js";
import {
  inspectProviderPolicy,
  providerPolicyFor,
  providerPolicyMatches,
  pushProviderPolicy,
} from "./backup-provider-observability.js";
import type { ProviderPolicySyncState } from "./backup-provider-observability.js";
import {
  failedReconciliation,
  runBackupReconciliation,
} from "./backup-reconciliation.js";
import type { BackupReconciliationState } from "./backup-reconciliation.js";
import { recoveryKitDocument } from "./backup-recovery-kit.js";
import { assembleSourceEntries } from "./backup-sources.js";
import type { AssembleOptions } from "./backup-sources.js";
import {
  deriveBackupSourceInstanceId,
  loadBackupState,
  opaqueLabel,
  saveBackupState,
} from "./backup-state.js";
import type { BackupTargetState } from "./backup-state.js";
import { RecoveryKitStateStore } from "./recovery-kit-state.js";
import type { RecoveryKitState } from "./recovery-kit-state.js";
import {
  drillErrors,
  drillWarnings,
  runRestoreDrill,
  spineCensus,
} from "./restore-drill.js";
import type { SpineCensus } from "./restore-drill.js";
import { warmPreviewTinies } from "./restore-warm.js";
import type { PreviewsWarmResult } from "./restore-warm.js";
import { snapshotReferencedBlobShas } from "./snapshot-blob-roots.js";
import type { StorageConnectionStore } from "./storage-connections.js";
import {
  discardWalFiles,
  drainWalFiles,
  pruneWalGenerations,
} from "./wal-uploader.js";

export { type RecoveryKitState } from "./recovery-kit-state.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export interface WalDrainPolicyDue {
  rpoSeconds: number;
  lastAttemptMs?: number;
}

export function walDrainDelayMs(
  configured: boolean,
  policies: readonly WalDrainPolicyDue[],
  nowMs: number
): number | undefined {
  if (!configured) return undefined;
  if (policies.length === 0) return MIN_RPO_SECONDS * 1000;
  return Math.min(
    ...policies.map(({ rpoSeconds, lastAttemptMs }) => {
      const rpoMs = Math.max(MIN_RPO_SECONDS, rpoSeconds) * 1000;
      if (lastAttemptMs === undefined) return rpoMs;
      return Math.max(0, lastAttemptMs + rpoMs - nowMs);
    })
  );
}

function newestReconciliation(
  first: BackupReconciliationState | undefined,
  second: BackupReconciliationState | undefined
): BackupReconciliationState | undefined {
  if (!first) return second;
  if (!second) return first;
  return Date.parse(first.checkedAt) >= Date.parse(second.checkedAt)
    ? first
    : second;
}

function applyInOrder<T>(
  values: Iterable<T>,
  apply: (value: T, index: number) => void | PromiseLike<void>
): Promise<void> {
  let index = 0;
  return Array.from(values).reduce<Promise<void>>(
    (sequence, value) => sequence.then(() => apply(value, index++)),
    Promise.resolve()
  );
}

function invalidateRestoredReplica(destDir: string): void {
  const vault = new DatabaseSync(path.join(destDir, "vault.db"));
  try {
    bumpReplicaEpoch(vault, { reason: "backup-restore" });
  } finally {
    vault.close();
  }
}

export function buildBackupProvider(
  config: BackupProviderConfig
): BackupProvider {
  return config.kind === "local"
    ? openLocalBackupProvider({ rootDir: config.dir })
    : openRemoteBackupProvider({
        baseUrl: config.endpoint,
        apiKey: config.apiKey,
      });
}

export interface BackupServiceOptions {
  config?: BackupConfig;
  cacheDir: string;
  gatewayDatabase?: GatewayDatabase;
  keyStore?: KeyStore;
  sourceInstanceId?: string;
  vaults: VaultRegistry;
  health: HealthRegistry;
  logger: RuntimeLogger;
  now?: () => number;
  assembleEntries?: (opts: AssembleOptions) => Promise<SourceEntry[]>;
  snapshot?: typeof createSnapshot;
  provider?: BackupProvider;
  storageConnections?: StorageConnectionStore;
  recoveryKit?: RecoveryKitStateStore;
  casReconcile?: typeof runCasOnlyReconciliation;
  shouldDeferPosture?: () => boolean;
  onDrainAccounted?: (info: {
    bytesUploaded: number;
    durationMs: number;
  }) => void;
  ownerOf?: (vaultId: string) => string | undefined;
  authorizedOwnerId?: () => string | undefined;
}

export type LazyRestoreResult = RestoreResult & {
  previewsWarm?: PreviewsWarmResult;
};

export interface LazyRestoreOption {
  remote: RemoteTier;
  warmConcurrency?: number;
}

export interface HomeDiscovery {
  retention: Retention;
  restoreCostClass: "free-egress" | "metered-egress";
}

export function recoveryWindowMs(
  retention: Retention | undefined
): number | undefined {
  if (retention?.kind === "ladder") return retention.dailyDays * DAY_MS;
  return undefined;
}

export interface RestoreEgressEstimate {
  costClass: "free-egress" | "metered-egress" | undefined;
  seq: number | undefined;
  fullBytes: number | undefined;
  lazyAvailable: boolean;
}

function pickSnapshotRow(
  rows: SnapshotRow[],
  opts: { seq?: number; pointInTimeMs?: number }
): SnapshotRow | undefined {
  if (opts.seq !== undefined) return rows.find((r) => r.seq === opts.seq);
  if (opts.pointInTimeMs !== undefined) {
    return rows.find((r) => r.createdAt * 1000 <= opts.pointInTimeMs!);
  }
  return rows[0];
}

const HOME_DISCOVERY_TTL_MS = 5 * 60 * 1000;

export class BackupService {
  private homeDiscoveryCache: { at: number; value: HomeDiscovery } | undefined;
  private readonly config: BackupConfig | undefined;
  private readonly cacheDir: string;
  private readonly vaults: VaultRegistry;
  private readonly health: HealthRegistry;
  private readonly logger: RuntimeLogger;
  private readonly now: () => number;
  private readonly provider: BackupProvider | undefined;
  private readonly storageConnections: StorageConnectionStore | undefined;
  private readonly gatewayDatabase: GatewayDatabase;
  private readonly keyStore: KeyStore;
  private readonly sourceInstanceId: string;
  private readonly assembleEntries: (
    opts: AssembleOptions
  ) => Promise<SourceEntry[]>;
  private readonly snapshot: typeof createSnapshot;
  private readonly casReconcile: typeof runCasOnlyReconciliation;
  private readonly recoveryKit: RecoveryKitStateStore;
  private readonly onDrainAccounted:
    | ((info: { bytesUploaded: number; durationMs: number }) => void)
    | undefined;
  private readonly shouldDeferPosture: () => boolean;
  private readonly ownerOf:
    | ((vaultId: string) => string | undefined)
    | undefined;
  private readonly authorizedOwnerId: (() => string | undefined) | undefined;
  private keyring: Keyring | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private walTimer: ReturnType<typeof setTimeout> | undefined;
  private walTimerDueAtMs: number | undefined;
  private draining = false;
  private readonly lastWalDrainAttemptMs = new Map<string, number>();
  private stopped = false;
  private chain: Promise<void> = Promise.resolve();
  private activeRun:
    | {
        vaultId: string;
        kind: "backup" | "verify" | "restore-verify" | "reconcile";
      }
    | undefined;

  constructor(opts: BackupServiceOptions) {
    this.config = opts.config;
    this.cacheDir = opts.cacheDir;
    this.vaults = opts.vaults;
    this.health = opts.health;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.provider =
      opts.provider ??
      (this.config ? buildBackupProvider(this.config.provider) : undefined);
    this.storageConnections = opts.storageConnections;
    this.gatewayDatabase =
      opts.gatewayDatabase ?? GatewayDatabase.open(this.cacheDir);
    const firstPlane = this.vaults.planesList()[0];
    this.keyStore =
      opts.keyStore ??
      new KeyStore(
        firstPlane
          ? path.dirname(sealKeyFileFor(firstPlane.dir))
          : path.join(this.cacheDir, "keys")
      );
    this.sourceInstanceId =
      opts.sourceInstanceId ??
      deriveBackupSourceInstanceId(
        this.keyStore.loadOrCreate("endpoint-key.bin")
      );
    this.assembleEntries = opts.assembleEntries ?? assembleSourceEntries;
    this.snapshot = opts.snapshot ?? createSnapshot;
    this.casReconcile = opts.casReconcile ?? runCasOnlyReconciliation;
    this.recoveryKit =
      opts.recoveryKit ??
      new RecoveryKitStateStore(this.gatewayDatabase, this.now);
    this.onDrainAccounted = opts.onDrainAccounted;
    this.shouldDeferPosture = opts.shouldDeferPosture ?? (() => false);
    this.ownerOf = opts.ownerOf;
    this.authorizedOwnerId = opts.authorizedOwnerId;

    this.health.registerProbe("backups", async () => this.probe());
  }

  private async backend(): Promise<
    | {
        provider: BackupProvider;
        providerRef: string;
        label: string;
        dynamic: boolean;
      }
    | undefined
  > {
    return resolveBackupBackend({
      ...(this.config ? { config: this.config } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      ...(this.storageConnections
        ? { storageConnections: this.storageConnections }
        : {}),
    });
  }

  async configured(): Promise<{ configured: boolean; provider?: string }> {
    const backend = await this.backend();
    return backend
      ? { configured: true, provider: backend.label }
      : { configured: false };
  }

  async homeDiscovery(): Promise<HomeDiscovery | undefined> {
    const backend = await this.backend();
    if (!backend) return undefined;
    const at = this.now();
    const cached = this.homeDiscoveryCache;
    if (cached && at - cached.at < HOME_DISCOVERY_TTL_MS) return cached.value;
    const caps = await backend.provider.capabilities();
    const value: HomeDiscovery = caps.backup
      ? {
          retention: caps.backup.retention,
          restoreCostClass: caps.backup.restoreCostClass,
        }
      : { retention: { kind: "none" }, restoreCostClass: "free-egress" };
    this.homeDiscoveryCache = { at, value };
    return value;
  }

  private async probe(): Promise<{
    status: "ok" | "degraded" | "error";
    detail?: string;
  }> {
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    const backend = await this.backend();
    const backup = backend
      ? evaluateBackupHealth({
          state,
          policyForVault: (vaultId) => this.policyForVault(vaultId),
          now: this.now(),
        })
      : { status: "ok" as const, detail: "backup is not configured" };
    const casErrors: string[] = [];
    const casWarnings: string[] = [];
    for (const plane of this.vaults.planesList()) {
      const vaultId = plane.boot.vaultId;
      if (
        readBlobStoreSettings(plane.db.vault).kind === "s3" &&
        !state.targets[vaultId]
      ) {
        casWarnings.push(
          `${vaultId}: remote CAS stores offsite bytes but has no backup target; ` +
            "the recovery kit cannot restore those bytes"
        );
      }
    }
    for (const [vaultId, reconciliation] of Object.entries(
      state.casReconciliations
    )) {
      const detail =
        `${vaultId}: remote CAS inventory ${reconciliation.status} — ` +
        `${reconciliation.cas.missing.count} missing/corrupt, ` +
        `${reconciliation.cas.orphans.count} orphan(s)`;
      if (reconciliation.status === "error") casErrors.push(detail);
      else if (reconciliation.status === "degraded") casWarnings.push(detail);
      const staleMs = this.policyForVault(vaultId).verifyEveryDays * DAY_MS * 2;
      if (this.now() - Date.parse(reconciliation.checkedAt) >= staleMs) {
        casWarnings.push(
          `${vaultId}: remote CAS inventory reconciliation is stale`
        );
      }
    }
    if (backup.status === "error" || casErrors.length > 0) {
      return {
        status: "error",
        detail: [
          ...(backup.status === "error" && backup.detail
            ? [backup.detail]
            : []),
          ...casErrors,
        ].join("; "),
      };
    }
    if (backup.status === "degraded" || casWarnings.length > 0) {
      return {
        status: "degraded",
        detail: [
          ...(backup.status === "degraded" && backup.detail
            ? [backup.detail]
            : []),
          ...casWarnings,
        ].join("; "),
      };
    }
    return backup;
  }

  private policyForVault(vaultId: string): BackupPolicy {
    const plane = this.vaults.get(vaultId);
    return plane ? readBackupPolicy(plane.db.vault) : DEFAULT_BACKUP_POLICY;
  }

  private async ensureKeyring(): Promise<Keyring> {
    if (this.keyring) return this.keyring;
    const existing = this.keyStore.export("keyring.key");
    if (existing) {
      this.keyring = validateKeyring(JSON.parse(existing.toString("utf8")));
      return this.keyring;
    }
    this.keyring = {
      version: 1,
      active: 1,
      epochs: [
        {
          epoch: 1,
          key: randomBytes(32).toString("base64"),
          createdAt: new Date(this.now()).toISOString(),
        },
      ],
    };
    this.keyStore.import(
      "keyring.key",
      Buffer.from(JSON.stringify(this.keyring), "utf8")
    );
    this.logger.info(
      `backup: minted a fresh wrapped keyring in ${this.keyStore.dir}`
    );
    return this.keyring;
  }

  private assertTargetBackend(
    target: BackupTargetState,
    backend: { providerRef: string; dynamic: boolean }
  ): void {
    if (
      target.providerRef
        ? target.providerRef !== backend.providerRef
        : backend.dynamic
    ) {
      throw new Error(
        "backup destination changed; refusing to use the prior target through a different provider"
      );
    }
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private assertRunning(): void {
    if (this.stopped) throw new Error("backup service is stopped");
  }

  async syncPolicy(vaultId: string): Promise<ProviderPolicySyncState> {
    this.assertRunning();
    const plane = this.vaults.get(vaultId);
    if (!plane) throw new Error(`backup: unknown vault "${vaultId}"`);
    const desired = providerPolicyFor(readBackupPolicy(plane.db.vault));
    let result: ProviderPolicySyncState = {
      status: "pending",
      desired,
      checkedAt: new Date(this.now()).toISOString(),
    };
    await this.enqueue(async () => {
      const state = await loadBackupState(
        this.gatewayDatabase,
        this.sourceInstanceId
      );
      const target = state.targets[vaultId];
      if (!target) return;
      const backend = await this.backend();
      if (!backend) {
        target.providerPolicy = result;
        await saveBackupState(this.gatewayDatabase, state);
        return;
      }
      this.assertTargetBackend(target, backend);
      result = await pushProviderPolicy({
        provider: backend.provider,
        targetId: target.targetId,
        desired,
        checkedAt: new Date(this.now()).toISOString(),
      });
      target.providerPolicy = result;
      await saveBackupState(this.gatewayDatabase, state);
    });
    await this.refreshWalSchedule();
    return result;
  }

  private async syncEnabledPolicies(): Promise<void> {
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    await applyInOrder(this.vaults.planesList(), async (plane) => {
      const vaultId = plane.boot.vaultId;
      if (!state.targets[vaultId]) return;
      this.attachSnapshotRoots(plane);
      await this.syncPolicy(vaultId);
    });
  }

  private attachSnapshotRoots(plane: VaultPlane): void {
    const vaultId = plane.boot.vaultId;
    plane.snapshotBlobRoots = async (): Promise<ReadonlySet<string>> => {
      const backend = await this.backend();
      if (!backend) return new Set<string>();
      const state = await loadBackupState(
        this.gatewayDatabase,
        this.sourceInstanceId
      );
      const target = state.targets[vaultId];
      if (!target) return new Set<string>();
      return snapshotReferencedBlobShas({
        provider: backend.provider,
        targetId: target.targetId,
        vaultId,
        keyring: await this.ensureKeyring(),
        manifestBlobCache: this.manifestBlobCache,
      });
    };
    plane.orphanGraceWindowMs = async (): Promise<number | undefined> => {
      const discovery = await this.homeDiscovery();
      return recoveryWindowMs(discovery?.retention);
    };
  }

  async runBackup(vaultId: string): Promise<void> {
    this.assertRunning();
    return this.enqueue(async () => {
      this.activeRun = { vaultId, kind: "backup" };
      try {
        await this.doRunBackup(vaultId);
      } finally {
        this.activeRun = undefined;
      }
    });
  }

  async runAll(): Promise<void> {
    this.assertRunning();
    await applyInOrder(this.vaults.planesList(), async (plane) => {
      await this.runBackup(plane.boot.vaultId);
    });
  }

  isRunning(vaultId?: string): boolean {
    if (!this.activeRun) return false;
    return vaultId === undefined || this.activeRun.vaultId === vaultId;
  }

  private async doRunBackup(vaultId: string): Promise<void> {
    const backend = await this.backend();
    if (!backend)
      throw new Error(
        "backup is not configured — add a provider backup connection"
      );
    const plane = this.vaults.get(vaultId);
    if (!plane) {
      this.logger.warn(`backup: unknown vault "${vaultId}" — skipped`);
      return;
    }
    if (this.ownerOf && this.authorizedOwnerId) {
      const owner = this.ownerOf(vaultId);
      const authorized = this.authorizedOwnerId();
      if (
        owner !== undefined &&
        authorized !== undefined &&
        owner !== authorized
      ) {
        this.logger.warn(
          `backup: vault ${vaultId} is owned by a different person than this machine's backup configuration is authorized for — skipped (#726)`
        );
        return;
      }
    }
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    let target = state.targets[vaultId];
    if (target?.fenced) {
      this.logger.warn(
        `backup: vault ${vaultId} is fenced (another machine took over) — refusing to auto-backup`
      );
      return;
    }
    if (
      target &&
      (target.providerRef
        ? target.providerRef !== backend.providerRef
        : backend.dynamic)
    ) {
      const message =
        "backup destination changed; refusing to reuse the prior target automatically";
      target.lastError = message;
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
      this.health.reportError("backups", `vault ${vaultId}: ${message}`);
      throw new Error(message);
    }
    const keyring = await this.ensureKeyring();
    let createdTarget = false;
    if (!target) {
      const label = opaqueLabel();
      const { targetId } = await backend.provider.createTarget({ label });
      target = {
        targetId,
        label,
        generation: 1,
        providerRef: backend.providerRef,
        firstBackupAt: new Date(this.now()).toISOString(),
      };
      createdTarget = true;
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
    }
    this.attachSnapshotRoots(plane);
    const desiredPolicy = providerPolicyFor(readBackupPolicy(plane.db.vault));
    if (
      createdTarget ||
      !target.providerPolicy ||
      !providerPolicyMatches(target.providerPolicy.desired, desiredPolicy)
    ) {
      target.providerPolicy = await pushProviderPolicy({
        provider: backend.provider,
        targetId: target.targetId,
        desired: desiredPolicy,
        checkedAt: new Date(this.now()).toISOString(),
      });
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
    }

    const shipper = plane.walShipper;
    plane.walTick();
    if (!shipper) {
      target.lastError = "backup: WAL shipper is unavailable";
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
      throw new Error(target.lastError);
    }
    if (shipper.streamDiscarded() || !shipper.baseReady()) {
      throw new Error(
        "backup: WAL generation is discarded or mid-break — retrying instead of registering a holed base"
      );
    }

    const shipStatus = shipper.status();
    if (shipStatus.foreignCheckpointCount > 0) {
      target.walForeignCheckpointCount = shipStatus.foreignCheckpointCount;
      if (shipStatus.lastForeignCheckpoint) {
        target.walLastForeignCheckpoint = {
          ...shipStatus.lastForeignCheckpoint,
        };
      }
    }

    if (shipper) {
      const pins = (target.walGenerationEpochs ??= {});
      const base = shipper.currentBase();
      const stale =
        base !== null &&
        pins[base.generation] !== undefined &&
        pins[base.generation] !== keyring.active;
      if (stale) {
        shipper.rollGeneration("key-epoch-rotation");
        const fresh = shipper.currentBase();
        const unrolled = fresh?.generation === base.generation;
        if (unrolled) {
          throw new Error(
            "backup: the key-epoch rotation roll did not complete (busy checkpoint) — retrying later"
          );
        }
        pins[fresh!.generation] = keyring.active;
      } else if (base) {
        pins[base.generation] ??= keyring.active;
      }
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
    }

    const walTipTickMs = shipper
      ? this.confirmedMarkerTip(shipper, target)
      : undefined;

    const bundleDir = path.join(this.cacheDir, "code-bundle", vaultId);
    try {
      const entries = await this.assembleEntries({
        plane,
        bundleDir,
        ...(walTipTickMs === undefined ? {} : { walTipTickMs }),
        log: {
          info: (m) => this.logger.info(m),
          warn: (m) => this.logger.warn(m),
        },
      });
      const row = await this.snapshot({
        provider: backend.provider,
        targetId: target.targetId,
        keyring,
        vaultId,
        entries,
        generation: target.generation,
        appMeta: this.appMetaFor(plane, state.sourceInstanceId),
        log: {
          info: (m) => this.logger.info(m),
          warn: (m) => this.logger.warn(m),
        },
      });
      const completedAt = new Date(this.now()).toISOString();
      target.firstBackupAt ??= completedAt;
      target.lastBackupAt = completedAt;
      if (row) target.lastSeq = row.seq;
      delete target.lastError;
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
      if (shipper) {
        const dbEntries = entries.filter(
          (e): e is SourceEntry & { walGeneration: string } =>
            e.kind === "db" && e.walGeneration !== undefined
        );
        const anchored = row
          ? new Set(dbEntries.map((e) => e.walGeneration))
          : await this.manifestAnchoredGenerations(
              backend.provider,
              target.targetId,
              keyring,
              vaultId
            );
        target.walGenerationEpochs ??= {};
        let pinsDirty = false;
        for (const entry of dbEntries) {
          if (!anchored.has(entry.walGeneration)) {
            this.logger.warn(
              `backup: no manifest anchors ${entry.path}'s generation ${entry.walGeneration} — ` +
                "leaving its base PENDING so registration keeps retrying (a base marked " +
                "registered without a manifest loses every restore point since the last one)"
            );
            continue;
          }
          shipper.noteBaseRegistered(entry.walGeneration);
          if (target.walGenerationEpochs[entry.walGeneration] === undefined) {
            target.walGenerationEpochs[entry.walGeneration] = keyring.active;
            pinsDirty = true;
          }
        }
        if (pinsDirty) {
          state.targets[vaultId] = target;
          await saveBackupState(this.gatewayDatabase, state);
        }
        try {
          const pruned = await pruneWalGenerations({
            plane,
            provider: backend.provider,
            targetId: target.targetId,
            keyring,
            vaultId,
            manifestGenerationCache: this.manifestGenerationCache,
            logger: this.logger,
          });
          if (target.walGenerationEpochs) {
            for (const gen of Object.keys(target.walGenerationEpochs)) {
              if (!pruned.keptGenerations.has(gen))
                delete target.walGenerationEpochs[gen];
            }
          }
          if (target.walMarkerTips) {
            for (const generation of Object.keys(target.walMarkerTips)) {
              if (!pruned.keptGenerations.has(generation))
                delete target.walMarkerTips[generation];
            }
          }
          if (target.walGenerationEpochs || target.walMarkerTips) {
            state.targets[vaultId] = target;
            await saveBackupState(this.gatewayDatabase, state);
          }
        } catch (error) {
          this.logger.warn(
            `backup: wal prune failed (kept everything): ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
      this.health.reportOk(
        "backups",
        row
          ? `vault ${vaultId}: backed up (seq ${row.seq})`
          : `vault ${vaultId}: no change since last backup`
      );
    } catch (error) {
      if (
        error instanceof BackupProviderError &&
        error.code === "conflict_generation"
      ) {
        target.fenced = true;
        target.lastError =
          "another machine has taken over this vault (conflict_generation) — backups stopped";
        state.targets[vaultId] = target;
        await saveBackupState(this.gatewayDatabase, state);
        this.health.reportError(
          "backups",
          `vault ${vaultId}: ${target.lastError}`
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      target.lastError = message;
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
      this.health.reportError(
        "backups",
        `vault ${vaultId}: backup failed: ${message}`
      );
      throw error;
    }
  }

  private confirmedMarkerTip(
    shipper: NonNullable<VaultPlane["walShipper"]>,
    target: BackupTargetState
  ): number | undefined {
    const base = shipper.currentBase();
    if (!base) return undefined;
    return target.walMarkerTips?.[base.generation];
  }

  private async syncWalForeignCheckpoints(
    vaultId: string,
    shipper: NonNullable<VaultPlane["walShipper"]>
  ): Promise<void> {
    const st = shipper.status();
    if (st.foreignCheckpointCount === 0) return;
    const fresh = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    const target = fresh.targets[vaultId];
    if (!target) return;
    if (
      target.walForeignCheckpointCount === st.foreignCheckpointCount &&
      target.walLastForeignCheckpoint?.atMs === st.lastForeignCheckpoint?.atMs
    ) {
      return;
    }
    target.walForeignCheckpointCount = st.foreignCheckpointCount;
    if (st.lastForeignCheckpoint) {
      target.walLastForeignCheckpoint = {
        atMs: st.lastForeignCheckpoint.atMs,
        reason: st.lastForeignCheckpoint.reason,
      };
    }
    await saveBackupState(this.gatewayDatabase, fresh);
  }

  private appMetaFor(
    plane: VaultPlane,
    sourceInstanceId: string
  ): Record<string, string> {
    const row = plane.db.vault.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    return {
      gatewayVersion: GATEWAY_VERSION,
      vaultUserVersion: String(row?.user_version ?? VAULT_MIGRATIONS.length),
      ontologyVersion: ONTOLOGY_VERSION,
      sourceInstanceId,
    };
  }

  async runVerify(vaultId: string): Promise<VerifySnapshotResult | undefined> {
    this.assertRunning();
    let result: VerifySnapshotResult | undefined;
    await this.enqueue(async () => {
      this.activeRun = { vaultId, kind: "verify" };
      try {
        result = await this.doRunVerify(vaultId);
      } finally {
        this.activeRun = undefined;
      }
    });
    return result;
  }

  async verifyAll(): Promise<void> {
    this.assertRunning();
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    await applyInOrder(this.vaults.planesList(), async (plane) => {
      if (state.targets[plane.boot.vaultId])
        await this.runVerify(plane.boot.vaultId);
    });
  }

  private async doRunVerify(
    vaultId: string
  ): Promise<VerifySnapshotResult | undefined> {
    const backend = await this.backend();
    if (!backend)
      throw new Error(
        "backup is not configured — add a provider backup connection"
      );
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    const target = state.targets[vaultId];
    if (!target) {
      this.logger.warn(
        `backup verify: vault ${vaultId} has no backup target yet — skipped`
      );
      return undefined;
    }
    this.assertTargetBackend(target, backend);
    const keyring = await this.ensureKeyring();
    try {
      const result = await verifySnapshot({
        provider: backend.provider,
        targetId: target.targetId,
        keyring,
        vaultId,
      });
      if (result.missing.length > 0 || result.corrupt.length > 0) {
        target.lastVerifyError = `verify found ${result.missing.length} missing, ${result.corrupt.length} corrupt object(s)`;
        this.health.reportError(
          "backups",
          `vault ${vaultId}: verify found ${result.missing.length} missing, ${result.corrupt.length} corrupt object(s)`
        );
      } else {
        target.lastVerifiedAt = new Date(this.now()).toISOString();
        delete target.lastVerifyError;
        this.health.reportOk(
          "backups",
          `vault ${vaultId}: verify ok (${result.checkedObjects} checked, ${result.sampled} sampled)`
        );
      }
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      target.lastVerifyError = `verify failed: ${message}`;
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
      this.health.reportError(
        "backups",
        `vault ${vaultId}: verify failed: ${message}`
      );
      throw error;
    }
  }

  async runReconciliation(
    vaultId: string,
    opts: { verifyBucket?: boolean } = {}
  ): Promise<BackupReconciliationState | undefined> {
    this.assertRunning();
    let result: BackupReconciliationState | undefined;
    await this.enqueue(async () => {
      this.activeRun = { vaultId, kind: "reconcile" };
      try {
        result = await this.doRunReconciliation(
          vaultId,
          opts.verifyBucket ?? false
        );
      } finally {
        this.activeRun = undefined;
      }
    });
    return result;
  }

  async verifyAgainstBucket(
    vaultId: string
  ): Promise<BackupReconciliationState | undefined> {
    return this.runReconciliation(vaultId, { verifyBucket: true });
  }

  private async doRunReconciliation(
    vaultId: string,
    verifyBucket: boolean
  ): Promise<BackupReconciliationState | undefined> {
    const plane = this.vaults.get(vaultId);
    if (!plane) throw new Error(`backup: unknown vault "${vaultId}"`);
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    const target = state.targets[vaultId];
    const backend = await this.backend();
    const checkedAt = new Date(this.now()).toISOString();
    let summary: BackupReconciliationState;
    if (backend && target) {
      this.assertTargetBackend(target, backend);
      const desired = providerPolicyFor(readBackupPolicy(plane.db.vault));
      if (
        target.providerPolicy?.status !== "rejected" ||
        !providerPolicyMatches(target.providerPolicy.desired, desired)
      ) {
        target.providerPolicy = await inspectProviderPolicy({
          provider: backend.provider,
          targetId: target.targetId,
          desired,
          checkedAt,
        });
      }
      try {
        target.reconciliation = await runBackupReconciliation({
          provider: backend.provider,
          targetId: target.targetId,
          vaultId,
          keyring: await this.ensureKeyring(),
          db: plane.db,
          ...(this.storageConnections
            ? { storageConnections: this.storageConnections }
            : {}),
          ...(target.walMarkerTips
            ? { walMarkerTips: target.walMarkerTips }
            : {}),
          manifestBlobCache: this.manifestBlobCache,
          verifyBucket,
          checkedAt,
        });
      } catch (error) {
        target.reconciliation = failedReconciliation(
          checkedAt,
          verifyBucket ? "bucket" : "scheduled",
          error instanceof Error ? error.message : String(error)
        );
      }
      summary = target.reconciliation;
      state.targets[vaultId] = target;
      delete state.casReconciliations[vaultId];
    } else {
      if (readBlobStoreSettings(plane.db.vault).kind !== "s3") {
        this.logger.info(
          `backup reconcile: vault ${vaultId} has no remote store — skipped`
        );
        return undefined;
      }
      try {
        summary = await this.casReconcile({
          db: plane.db,
          ...(this.storageConnections
            ? { storageConnections: this.storageConnections }
            : {}),
          verifyBucket,
          checkedAt,
        });
      } catch (error) {
        summary = failedCasOnlyReconciliation(
          checkedAt,
          verifyBucket ? "bucket" : "scheduled",
          error instanceof Error ? error.message : String(error)
        );
      }
      state.casReconciliations[vaultId] = summary;
    }
    await saveBackupState(this.gatewayDatabase, state);
    const detail =
      `vault ${vaultId}: inventory ${summary.status} — ` +
      `${summary.cas.missing.count} CAS missing, ${summary.backup.missing.count} backup missing, ` +
      `${summary.walGaps.count} WAL gap(s), ` +
      `${summary.cas.orphans.count + summary.backup.orphans.count} orphan(s)`;
    if (summary.status === "error") this.health.reportError("backups", detail);
    else if (summary.status === "degraded")
      this.health.reportDegraded("backups", detail);
    else this.health.reportOk("backups", detail);
    return summary;
  }

  async runRestoreVerify(vaultId: string): Promise<void> {
    this.assertRunning();
    return this.enqueue(async () => {
      this.activeRun = { vaultId, kind: "restore-verify" };
      try {
        await this.doRunRestoreVerify(vaultId);
      } finally {
        this.activeRun = undefined;
      }
    });
  }

  private async doRunRestoreVerify(vaultId: string): Promise<void> {
    const backend = await this.backend();
    if (!backend)
      throw new Error(
        "backup is not configured — add a provider backup connection"
      );
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    const target = state.targets[vaultId];
    if (!target || target.lastSeq === undefined) {
      this.logger.info(
        `backup restore-verify: vault ${vaultId} has no snapshot yet — skipped`
      );
      return;
    }
    this.assertTargetBackend(target, backend);
    const keyring = await this.ensureKeyring();
    const destDir = path.join(
      this.cacheDir,
      "restore-verify",
      `${vaultId}-${this.now()}`
    );
    try {
      const result = await restoreSnapshot({
        provider: backend.provider,
        targetId: target.targetId,
        keyring,
        vaultId,
        destDir,
        current: {
          gatewayVersion: GATEWAY_VERSION,
          vaultUserVersion: String(VAULT_MIGRATIONS.length),
          ontologyVersion: ONTOLOGY_VERSION,
        },
        log: {
          info: (m) => this.logger.info(m),
          warn: (m) => this.logger.warn(m),
        },
      });
      const report = verifyRestoredPair(
        destDir,
        this.keyStore.export(`${vaultId}.sealkey`)
      );
      const problems: string[] = [];
      if (report.vault.integrity !== "ok")
        problems.push(`vault: ${report.vault.integrity}`);
      if (report.sealKey.verdict === "missing") {
        problems.push(
          `seal key absent — this vault has sealed secrets (${report.sealKey.expected}) that a ` +
            "restore without it can never open; the restore would be a placebo"
        );
      } else if (report.sealKey.verdict === "mismatch") {
        problems.push(
          `seal key does not match the vault's stamped fingerprint (${report.sealKey.expected}) — ` +
            "the restored key would turn every sealed cell into garbage; the restore would be a placebo"
        );
      }
      if (report.vault.foreignKeyViolations > 0) {
        problems.push(
          `vault: ${report.vault.foreignKeyViolations} fk violation(s)`
        );
      }
      const drill = runRestoreDrill({
        vaultId,
        destDir,
        seed: `${vaultId}:${result.seq}`,
        sourceCensus: this.liveSpineCensus(vaultId),
        skippedBlobs: result.skippedBlobs,
      });
      problems.push(...drillErrors(drill));
      const drillDegrades = drillWarnings(drill);
      if (result.walReplay) {
        const { damaged, cutTickMs, expectedCutMs } = result.walReplay;
        if (damaged.length > 0)
          problems.push(`${damaged.length} damaged wal object(s) skipped`);
        else if (expectedCutMs >= 0 && cutTickMs < expectedCutMs) {
          problems.push(
            "the wal stream is not restorable at its newest registered point (tick " +
              `${expectedCutMs}); it could only be cut at ${cutTickMs} — ` +
              "objects the provider acknowledged are missing"
          );
        }
      }
      if (problems.length > 0) {
        this.health.reportError(
          "backups",
          `vault ${vaultId}: restore-verify FAILED: ${problems.join("; ")}`
        );
        throw new Error(`restore-verify failed: ${problems.join("; ")}`);
      }
      const dangling = report.danglingReceipts.length;
      target.lastRestoreVerifiedAt = new Date(this.now()).toISOString();
      delete target.lastRestoreVerifyError;
      if (dangling > 0) target.lastRestoreVerifyDangling = dangling;
      else delete target.lastRestoreVerifyDangling;
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state);
      const ran =
        `vault ${vaultId}: restore-verify (seq ${result.seq}, ` +
        `${report.receiptsChecked} receipts cross-checked` +
        (result.walReplay
          ? `, wal tip ${result.walReplay.lastTickMs}`
          : ", /1 snapshot") +
        ")";
      if (dangling > 0 || drillDegrades.length > 0) {
        const reasons: string[] = [];
        if (dangling > 0) {
          reasons.push(
            `${dangling} receipt(s) reference absent vault rows — ` +
              "hard-deletes explain this; anything else needs eyes"
          );
        }
        reasons.push(...drillDegrades);
        this.health.reportDegraded("backups", `${ran}: ${reasons.join("; ")}`);
      } else {
        this.health.reportOk("backups", `${ran}: ok`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      target.lastRestoreVerifyError = message;
      state.targets[vaultId] = target;
      await saveBackupState(this.gatewayDatabase, state).catch(() => undefined);
      this.health.reportError(
        "backups",
        `vault ${vaultId}: restore-verify failed: ${message}`
      );
      throw error;
    } finally {
      await fs
        .rm(destDir, { recursive: true, force: true })
        .catch(() => undefined);
    }
  }

  private liveSpineCensus(vaultId: string): SpineCensus | undefined {
    const plane = this.vaults
      .planesList()
      .find((candidate) => candidate.boot.vaultId === vaultId);
    if (!plane) return undefined;
    return spineCensus(plane.db.vault);
  }

  private lastAutoBackupAttemptMs = new Map<string, number>();
  private readonly manifestGenerationCache = new Map<string, string[]>();
  private readonly manifestBlobCache = new Map<string, string[]>();

  private async manifestAnchoredGenerations(
    provider: BackupProvider,
    targetId: string,
    keyring: Keyring,
    vaultId: string
  ): Promise<Set<string>> {
    const anchored = new Set<string>();
    try {
      const rows = await provider.listSnapshots(targetId);
      const store = await provider.openDataPlane(targetId, "backup", "read");
      await applyInOrder(rows, async (row) => {
        let generations = this.manifestGenerationCache.get(row.manifestHash);
        if (!generations) {
          const opened = openManifest(
            await store.get(row.manifestKey),
            keyring,
            vaultId,
            row.manifestHash
          );
          generations = opened.entries
            .map((entry) => entry.walGeneration)
            .filter((gen): gen is string => gen !== undefined);
          this.manifestGenerationCache.set(row.manifestHash, generations);
        }
        for (const gen of generations) anchored.add(gen);
      });
    } catch (error) {
      this.logger.warn(
        `backup: could not read the registered manifests to confirm which generations they ` +
          `anchor (bases stay pending, registration retries): ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return anchored;
  }

  async drainWal(vaultIds?: ReadonlySet<string>): Promise<void> {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      await this.enqueue(() => this.doDrainPass(vaultIds));
    } finally {
      this.draining = false;
    }
  }

  private async drainWalDue(): Promise<void> {
    if (this.draining || this.stopped) return;
    const now = this.now();
    const due = new Set<string>();
    for (const plane of this.vaults.planesList()) {
      const vaultId = plane.boot.vaultId;
      const rpoMs = readBackupPolicy(plane.db.vault).rpoSeconds * 1000;
      const last = this.lastWalDrainAttemptMs.get(vaultId) ?? 0;
      if (now - last < rpoMs) continue;
      this.lastWalDrainAttemptMs.set(vaultId, now);
      due.add(vaultId);
    }
    if (due.size > 0) await this.drainWal(due);
  }

  private async doDrainPass(vaultIds?: ReadonlySet<string>): Promise<void> {
    const backend = await this.backend();
    await applyInOrder(this.vaults.planesList(), async (plane) => {
      if (this.stopped) return;
      const shipper = plane.walShipper;
      if (!shipper) return;
      const vaultId = plane.boot.vaultId;
      if (vaultIds && !vaultIds.has(vaultId)) return;
      if (!backend) {
        discardWalFiles(plane);
        return;
      }
      try {
        if (shipper.streamDiscarded()) {
          const rolled = shipper.rollGeneration(
            "backup-enabled-after-discard",
            { captureFirst: false }
          );
          if (
            rolled.busy ||
            rolled.errors.length > 0 ||
            shipper.streamDiscarded() ||
            !shipper.baseReady()
          ) {
            this.logger.warn(
              `backup: discarded WAL generation could not re-base cleanly; registration deferred`
            );
            return;
          }
        }
        let state = await loadBackupState(
          this.gatewayDatabase,
          this.sourceInstanceId
        );
        let target = state.targets[vaultId];
        if (target?.fenced) return;
        const needsRegistration = !target || shipper.pendingBase() !== null;
        if (needsRegistration) {
          const last = this.lastAutoBackupAttemptMs.get(vaultId) ?? 0;
          if (this.now() - last >= 5 * 60 * 1000) {
            this.lastAutoBackupAttemptMs.set(vaultId, this.now());
            await this.doRunBackup(vaultId).catch((error) => {
              this.logger.warn(
                `backup: base registration for ${vaultId} failed (segments keep accumulating locally): ` +
                  `${error instanceof Error ? error.message : String(error)}`
              );
            });
            state = await loadBackupState(
              this.gatewayDatabase,
              this.sourceInstanceId
            );
            target = state.targets[vaultId];
          }
        }
        if (!target || target.fenced) return;
        this.assertTargetBackend(target, backend);
        const keyring = await this.ensureKeyring();
        const newPins: Record<string, number> = {};
        const drainStartedAt = this.now();
        const result = await drainWalFiles({
          plane,
          provider: backend.provider,
          targetId: target.targetId,
          keyring,
          vaultId,
          epochForGeneration: (generation) => {
            const pinned =
              target.walGenerationEpochs?.[generation] ?? newPins[generation];
            if (pinned !== undefined) return pinned;
            newPins[generation] = keyring.active;
            return keyring.active;
          },
          logger: this.logger,
        });
        this.onDrainAccounted?.({
          bytesUploaded: result.bytes,
          durationMs: this.now() - drainStartedAt,
        });
        {
          const freshState = await loadBackupState(
            this.gatewayDatabase,
            this.sourceInstanceId
          );
          const freshTarget = freshState.targets[vaultId];
          if (freshTarget) {
            freshTarget.lastWalDrainAt = new Date(this.now()).toISOString();
            freshTarget.walGenerationEpochs = {
              ...freshTarget.walGenerationEpochs,
              ...newPins,
            };
            const tips = (freshTarget.walMarkerTips ??= {});
            for (const [generation, tickMs] of Object.entries(
              result.markerTips
            )) {
              tips[generation] = Math.max(tips[generation] ?? -1, tickMs);
            }
            await saveBackupState(this.gatewayDatabase, freshState);
          }
        }
        if (result.uploaded > 0) {
          this.logger.info(
            `backup: drained ${result.uploaded} wal object(s), ${result.bytes} sealed byte(s) (${vaultId})`
          );
        }
        await this.syncWalForeignCheckpoints(vaultId, shipper);
      } catch (error) {
        this.logger.warn(
          `backup: wal drain for ${vaultId} failed (will retry): ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
  }

  start(): void {
    if (this.timer) return;
    void this.syncEnabledPolicies().catch((error) => {
      this.logger.warn(
        `backup: provider policy sync failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    const runScheduled = () => {
      if (
        this.health.shouldDeferBackgroundWork() ||
        this.health.shouldPauseBackgroundWork() ||
        this.shouldDeferPosture()
      )
        return;
      void this.tick().catch((error) => {
        this.logger.warn(
          `backup: scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    };
    this.timer = setTimeout(() => {
      if (this.stopped) return;
      runScheduled();
      this.timer = setInterval(runScheduled, HOUR_MS);
      unrefTimer(this.timer);
    }, jitterDelayMs(HOUR_MS));
    unrefTimer(this.timer);
    void this.refreshWalSchedule().catch((error) => {
      this.logger.warn(
        `backup: wal scheduler setup failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }

  async refreshWalSchedule(): Promise<void> {
    const configured = (await this.backend()) !== undefined;
    const now = this.now();
    const state = configured
      ? await loadBackupState(this.gatewayDatabase, this.sourceInstanceId)
      : undefined;
    const policies = configured
      ? this.vaults.planesList().map((plane) => {
          const vaultId = plane.boot.vaultId;
          let lastAttemptMs = this.lastWalDrainAttemptMs.get(vaultId);
          if (lastAttemptMs === undefined) {
            const persisted = Date.parse(
              state?.targets[vaultId]?.lastWalDrainAt ?? ""
            );
            lastAttemptMs = Number.isFinite(persisted) ? persisted : now;
            this.lastWalDrainAttemptMs.set(vaultId, lastAttemptMs);
          }
          return {
            rpoSeconds: readBackupPolicy(plane.db.vault).rpoSeconds,
            lastAttemptMs,
          };
        })
      : [];
    const remainingMs = walDrainDelayMs(configured, policies, now);
    const delayMs =
      remainingMs === undefined
        ? undefined
        : Math.max(
            this.health.shouldDeferBackgroundWork() ? 1_000 : 0,
            remainingMs
          );
    const dueAtMs = delayMs === undefined ? undefined : now + delayMs;
    if (dueAtMs === this.walTimerDueAtMs) return;
    if (this.walTimer) clearTimeout(this.walTimer);
    this.walTimer = undefined;
    this.walTimerDueAtMs = dueAtMs;
    if (delayMs === undefined) return;
    this.walTimer = setTimeout(() => {
      if (this.stopped || this.walTimerDueAtMs !== dueAtMs) return;
      this.walTimer = undefined;
      this.walTimerDueAtMs = undefined;
      const run = async () => {
        if (!this.health.shouldDeferBackgroundWork()) await this.drainWalDue();
        await this.refreshWalSchedule();
      };
      void run().catch((error) => {
        this.logger.warn(
          `backup: wal drain tick failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
    }, delayMs);
    unrefTimer(this.walTimer);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.walTimer) {
      clearTimeout(this.walTimer);
      this.walTimer = undefined;
    }
    this.walTimerDueAtMs = undefined;
    await this.chain.catch(() => undefined);
  }

  async tick(): Promise<void> {
    if (this.stopped) return;
    const backupConfigured = (await this.backend()) !== undefined;
    await applyInOrder(this.vaults.planesList(), async (plane) => {
      const vaultId = plane.boot.vaultId;
      const policy = readBackupPolicy(plane.db.vault);
      let state = await loadBackupState(
        this.gatewayDatabase,
        this.sourceInstanceId
      );
      let target = state.targets[vaultId];
      if (target?.fenced) return;
      if (backupConfigured && target) this.attachSnapshotRoots(plane);
      if (backupConfigured) {
        const backupDue =
          !target?.lastBackupAt ||
          this.now() - Date.parse(target.lastBackupAt) >=
            policy.snapshotIntervalHours * HOUR_MS;
        if (backupDue) {
          await this.runBackup(vaultId);
          state = await loadBackupState(
            this.gatewayDatabase,
            this.sourceInstanceId
          );
          target = state.targets[vaultId];
        }
        const verifyDue =
          target?.lastSeq !== undefined &&
          (!target.lastVerifiedAt ||
            this.now() - Date.parse(target.lastVerifiedAt) >=
              policy.verifyEveryDays * DAY_MS);
        if (verifyDue) {
          await this.runVerify(vaultId).catch((error) => {
            this.logger.warn(
              `backup: scheduled verify failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        }
        const restoreBaseline =
          target?.lastRestoreVerifiedAt ??
          target?.firstBackupAt ??
          target?.lastBackupAt;
        const restoreVerifyDue =
          target?.lastSeq !== undefined &&
          restoreBaseline !== undefined &&
          this.now() - Date.parse(restoreBaseline) >=
            policy.verifyEveryDays * DAY_MS;
        if (restoreVerifyDue) {
          await this.runRestoreVerify(vaultId).catch((error) => {
            this.logger.warn(
              `backup: scheduled restore-verify failed: ${error instanceof Error ? error.message : String(error)}`
            );
          });
        }
      }
      state = await loadBackupState(
        this.gatewayDatabase,
        this.sourceInstanceId
      );
      target = state.targets[vaultId];
      const remoteCas = readBlobStoreSettings(plane.db.vault).kind === "s3";
      const latestReconciliation =
        backupConfigured && target
          ? target.reconciliation
          : newestReconciliation(
              target?.reconciliation,
              state.casReconciliations[vaultId]
            );
      const reconciliationDue =
        ((backupConfigured && target !== undefined) || remoteCas) &&
        (latestReconciliation?.status === "error" ||
          !latestReconciliation?.checkedAt ||
          this.now() - Date.parse(latestReconciliation.checkedAt) >=
            policy.verifyEveryDays * DAY_MS);
      if (reconciliationDue) await this.runReconciliation(vaultId);
    });
  }

  async status(): Promise<Record<string, BackupTargetState>> {
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    return state.targets;
  }

  async casReconciliationStatus(): Promise<
    Record<string, BackupReconciliationState>
  > {
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    return state.casReconciliations;
  }

  async recoveryKitStatus(): Promise<RecoveryKitState> {
    const status = await this.recoveryKit.status();
    const backend = await this.backend();
    if (!backend) return status;
    const document = await this.currentRecoveryKitDocument(backend.label);
    const fingerprint = recoveryKitFingerprint(document);
    return status.kitFingerprint === fingerprint
      ? status
      : this.recoveryKit.begin(fingerprint);
  }

  async verifyRecoveryKit(input: {
    kit: unknown;
    password: string;
    lossConsent: true;
  }): Promise<RecoveryKitState> {
    if (input.lossConsent !== true)
      throw new Error("recovery-kit loss consent is required");
    const document = parseRecoveryKit(input.kit, input.password);
    const fingerprint = recoveryKitFingerprint(document);
    const state = await this.recoveryKit.verify(fingerprint);
    if (!state)
      throw new Error(
        "selected recovery kit is stale or belongs to another gateway"
      );
    return state;
  }

  async rotateKeyEpoch(): Promise<Keyring> {
    const current = await this.ensureKeyring();
    const epoch = Math.max(...current.epochs.map((entry) => entry.epoch)) + 1;
    const rotated: Keyring = {
      version: 1,
      active: epoch,
      epochs: [
        ...current.epochs,
        {
          epoch,
          key: randomBytes(32).toString("base64"),
          createdAt: new Date(this.now()).toISOString(),
        },
      ],
    };
    this.keyStore.import(
      "keyring.key",
      Buffer.from(JSON.stringify(rotated), "utf8")
    );
    this.keyring = rotated;
    await this.recoveryKitStatus();
    return rotated;
  }

  async fenceVaultForErase(vaultId: string): Promise<void> {
    const backend = await this.backend();
    if (!backend) return;
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    const target = state.targets[vaultId];
    if (!target) return;
    this.assertTargetBackend(target, backend);
    const plane = this.vaults.get(vaultId);
    if (!plane)
      throw new Error(
        `backup: cannot fence unknown vault "${vaultId}" before erase`
      );
    plane.walTick();
    const shipper = plane.walShipper;
    if (!shipper || shipper.streamDiscarded() || !shipper.baseReady()) {
      throw new Error(
        `backup: cannot fence vault "${vaultId}" with a discarded or mid-break WAL base`
      );
    }
    const targetInfo = await backend.provider.getTarget(target.targetId);
    const generation =
      Math.max(target.generation, targetInfo.currentGeneration) + 1;
    const bundleDir = path.join(this.cacheDir, "code-bundle", vaultId);
    const walTipTickMs = this.confirmedMarkerTip(shipper, target);
    const entries = await this.assembleEntries({
      plane,
      bundleDir,
      ...(walTipTickMs === undefined ? {} : { walTipTickMs }),
      log: {
        info: (message) => this.logger.info(message),
        warn: (message) => this.logger.warn(message),
      },
    });
    const row = await this.snapshot({
      provider: backend.provider,
      targetId: target.targetId,
      keyring: await this.ensureKeyring(),
      vaultId,
      entries,
      generation,
      appMeta: this.appMetaFor(plane, state.sourceInstanceId),
      forceRegistration: true,
      log: {
        info: (message) => this.logger.info(message),
        warn: (message) => this.logger.warn(message),
      },
    });
    if (!row)
      throw new Error(
        `backup: provider did not register erase fence for "${vaultId}"`
      );
    target.generation = generation;
    target.lastSeq = row.seq;
    state.targets[vaultId] = target;
    await saveBackupState(this.gatewayDatabase, state);
  }

  async listSnapshots(
    vaultId: string,
    opts?: { includePruned?: boolean }
  ): Promise<SnapshotRow[]> {
    const backend = await this.backend();
    if (!backend)
      throw new Error(
        "backup is not configured — add a provider backup connection"
      );
    const target = await this.requireTarget(vaultId);
    this.assertTargetBackend(target, backend);
    return backend.provider.listSnapshots(target.targetId, opts);
  }

  async restore(opts: {
    vaultId: string;
    destDir: string;
    seq?: number;
    pointInTimeMs?: number;
    full?: boolean;
    lazy?: LazyRestoreOption;
  }): Promise<LazyRestoreResult> {
    const backend = await this.backend();
    if (!backend)
      throw new Error(
        "backup is not configured — add a provider backup connection"
      );
    const target = await this.requireTarget(opts.vaultId);
    this.assertTargetBackend(target, backend);
    const keyring = await this.ensureKeyring();
    const lazy =
      opts.lazy ?? (opts.full ? undefined : this.autoLazyTier(opts.vaultId));
    const result = await restoreSnapshot({
      provider: backend.provider,
      targetId: target.targetId,
      keyring,
      vaultId: opts.vaultId,
      ...(opts.seq === undefined ? {} : { seq: opts.seq }),
      ...(opts.pointInTimeMs === undefined
        ? {}
        : { pointInTimeMs: opts.pointInTimeMs }),
      destDir: opts.destDir,
      ...(lazy ? { skipBlob: ({ sha }) => lazy.remote.store.has(sha) } : {}),
      log: {
        info: (m) => this.logger.info(m),
        warn: (m) => this.logger.warn(m),
      },
      current: {
        gatewayVersion: GATEWAY_VERSION,
        vaultUserVersion: String(VAULT_MIGRATIONS.length),
        ontologyVersion: ONTOLOGY_VERSION,
      },
    });
    invalidateRestoredReplica(opts.destDir);
    if (!lazy) return result;
    const restoreCompleteMs = this.now();
    const previewsWarm = await warmPreviewTinies({
      destDir: opts.destDir,
      remote: lazy.remote,
      startedAtMs: restoreCompleteMs,
      now: () => this.now(),
      ...(lazy.warmConcurrency === undefined
        ? {}
        : { concurrency: lazy.warmConcurrency }),
      log: {
        info: (m) => this.logger.info(m),
        warn: (m) => this.logger.warn(m),
      },
    });
    return { ...result, previewsWarm };
  }

  private autoLazyTier(vaultId: string): LazyRestoreOption | undefined {
    const remote = this.vaults.get(vaultId)?.db.remote() ?? null;
    return remote ? { remote } : undefined;
  }

  async restoreEgressEstimate(opts: {
    vaultId: string;
    seq?: number;
    pointInTimeMs?: number;
  }): Promise<RestoreEgressEstimate> {
    const discovery = await this.homeDiscovery();
    const lazyAvailable = this.autoLazyTier(opts.vaultId) !== undefined;
    let row: SnapshotRow | undefined;
    try {
      const rows = await this.listSnapshots(opts.vaultId);
      row = pickSnapshotRow(rows, opts);
    } catch {
      row = undefined;
    }
    return {
      costClass: discovery?.restoreCostClass,
      seq: row?.seq,
      fullBytes: row?.totalBytes,
      lazyAvailable,
    };
  }

  async writeKit(destFile: string, password: string): Promise<void> {
    const backend = await this.backend();
    if (!backend)
      throw new Error(
        "backup is not configured — add a provider backup connection"
      );
    const document = await this.currentRecoveryKitDocument(backend.label);
    const wrapped = wrapRecoveryKit(document, password);
    await fs.writeFile(destFile, `${JSON.stringify(wrapped, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const fingerprint = recoveryKitFingerprint(document);
    const status = await this.recoveryKit.status();
    if (status.kitFingerprint !== fingerprint)
      await this.recoveryKit.begin(fingerprint);
  }

  async recoveryKitDocument(): Promise<RecoveryKitDocument> {
    const backend = await this.backend();
    if (!backend)
      throw new Error(
        "backup is not configured — add a provider backup connection"
      );
    const document = await this.currentRecoveryKitDocument(backend.label);
    const fingerprint = recoveryKitFingerprint(document);
    const status = await this.recoveryKit.status();
    if (status.kitFingerprint !== fingerprint)
      await this.recoveryKit.begin(fingerprint);
    return document;
  }

  private async currentRecoveryKitDocument(
    provider: string
  ): Promise<RecoveryKitDocument> {
    const keyring = await this.ensureKeyring();
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    return recoveryKitDocument({
      keyring,
      state,
      provider,
      now: this.now(),
      keyStore: this.keyStore,
    });
  }

  private async requireTarget(vaultId: string): Promise<BackupTargetState> {
    const state = await loadBackupState(
      this.gatewayDatabase,
      this.sourceInstanceId
    );
    const target = state.targets[vaultId];
    if (!target)
      throw new Error(`backup: vault "${vaultId}" has no backup target yet`);
    return target;
  }
}
